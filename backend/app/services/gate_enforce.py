"""E-HITL-GATING S-GATE-2: 게이트 집행 — resolve_gate_level(S-GATE-1)을 done/merge 액션에 물려
auto(통과)/block(409)/ask(HitlRequest park) 집행. 정책 hitl-gating-policy-v1 §3.

dev 전용·flag-gated(`gate_config_enforce_active`)·무회귀(off면 미동작). 안전 하한(§3d·self-approval)
은 S-GATE-3. ask 재개=승인 후 재시도 통과(§6-2 A): 동일 work_item 의 승인된 HitlRequest 있으면 통과.
"""
from __future__ import annotations

import logging
import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.hitl import HitlRequest
from app.services.gate_config import ACTOR_TYPES, resolve_gate_level

logger = logging.getLogger(__name__)

_GATE_REQUEST_TYPE = "gate_approval"
# restrictiveness 순위(fail-closed 시 더 엄격한 레벨 선택): block > ask > auto.
_RESTRICT_RANK = {"auto": 0, "ask": 1, "block": 2}


async def _resolve_level_failclosed(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
    work_type: str,
    actor_type: str | None,
) -> str:
    """actor_type 신뢰 해소 + **fail-closed**. 알려진 actor(agent/human)면 그 레벨.

    actor_type 불명(None/미지원)이면 **None→"human" 절대 금지**(보안 결함) — 두 actor config 중
    **더 restrictive** 레벨 적용(에이전트 block 우회 차단·QA HIGH②). 호출부가 신뢰 actor_type 전달이
    1차 방어이고, 이는 방어심층(defense-in-depth) 백스톱.
    """
    if actor_type in ACTOR_TYPES:
        return await resolve_gate_level(
            session, org_id=org_id, project_id=project_id,
            work_type=work_type, actor_type=actor_type,
        )
    levels = [
        await resolve_gate_level(
            session, org_id=org_id, project_id=project_id, work_type=work_type, actor_type=at
        )
        for at in ACTOR_TYPES
    ]
    chosen = max(levels, key=lambda lv: _RESTRICT_RANK.get(lv, 1))
    logger.warning(
        "gate_enforced actor_type=%r unresolved → fail-closed most_restrictive level=%s",
        actor_type, chosen,
    )
    return chosen


# S-GATE-3 §3d **hard floor** — config 밑으로 못 내리는 안전 하한(hard-enforce·org config 무관).
# main 머지(work_type='merge')는 최소 'ask'(auto 금지). 'done'은 하한 없음(auto 허용). prod 액션은
# 별 work_type 신설 시 여기 추가(현재 work_types=done/merge). org가 auto로 설정해도 floor가 이긴다.
_SAFETY_FLOOR: dict[str, str] = {"merge": "ask"}


def _clamp_to_floor(level: str, work_type: str) -> str:
    """resolve 레벨을 안전 하한 위로 clamp(더 restrictive 채택). floor=ask면 auto→ask(다운 금지)."""
    floor = _SAFETY_FLOOR.get(work_type)
    if floor is None:
        return level
    return max((level, floor), key=lambda lv: _RESTRICT_RANK.get(lv, 1))


def _enforce_allowlist() -> set[uuid.UUID]:
    out: set[uuid.UUID] = set()
    for tok in (settings.gate_config_enforce_org_allowlist or "").split(","):
        tok = tok.strip()
        if tok:
            try:
                out.add(uuid.UUID(tok))
            except ValueError:
                pass
    return out


def gate_config_enforce_active(org_id: uuid.UUID) -> bool:
    """config 게이트 집행 활성 여부 — default-off·allowlist 점진 rollout(merge_gate_active 동형).

    off 면 enforce_gate 미동작(기존 done/merge 무변경·무회귀). enabled+allowlist 비면 전 org,
    지정 시 해당 org 만.
    """
    if not settings.gate_config_enforce_enabled:
        return False
    allow = _enforce_allowlist()
    return (not allow) or (org_id in allow)


async def enforce_gate(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
    work_type: str,
    actor_type: str | None,
    actor_id: uuid.UUID | None,
    work_item_id: uuid.UUID,
    work_item_title: str | None = None,
) -> None:
    """config 게이트 집행. flag-off/auto → 통과. block → 409. ask → 승인 있으면 통과·없으면
    HitlRequest(pending) park + 409(차단). raise 전 commit 으로 ask 요청 persist(_preflight 동형)."""
    if not gate_config_enforce_active(org_id):
        return
    # HIGH②: actor_type None→"human" 묵시 강등 금지 — fail-closed 해소(불명이면 더 restrictive).
    level = await _resolve_level_failclosed(
        session, org_id=org_id, project_id=project_id,
        work_type=work_type, actor_type=actor_type,
    )
    # S-GATE-3 ②③: 안전 하한 clamp(§3d hard) — floor 밑으로 못 내림(org config auto여도 floor가 이김).
    floored = _clamp_to_floor(level, work_type)
    if floored != level:
        logger.info(
            "gate_enforced org=%s work=%s floor_clamp %s→%s", org_id, work_type, level, floored
        )
    level = floored
    if level == "auto":
        logger.info(
            "gate_enforced org=%s project=%s work=%s actor=%s level=auto outcome=auto",
            org_id, project_id, work_type, actor_type,
        )
        return
    if level == "block":
        logger.info(
            "gate_enforced org=%s project=%s work=%s actor=%s level=block outcome=blocked",
            org_id, project_id, work_type, actor_type,
        )
        raise HTTPException(
            status_code=409,
            detail={
                "code": "GATE_BLOCKED",
                "work_type": work_type,
                "level": "block",
                "message": f"{work_type} 전이가 정책상 차단됨(block).",
            },
        )

    # level == "ask"
    wi = str(work_item_id)
    # 동일 work_item 의 **최신** gate_approval 결정이 거버넌스(최신 결정 우선):
    #   approved → 통과(§6-2 A 재시도 통과) · rejected → 409 차단(재-ask 금지·QA② reject 차단 유지)
    #   pending  → 기존 request 재사용(dup park 방지) · 없음 → 신규 pending park.
    row = (
        await session.execute(
            select(
                HitlRequest.id,
                HitlRequest.status,
                HitlRequest.responded_by,
                HitlRequest.hitl_metadata["actor_id"].astext,
            ).where(
                HitlRequest.org_id == org_id,
                HitlRequest.request_type == _GATE_REQUEST_TYPE,
                HitlRequest.deleted_at.is_(None),
                HitlRequest.hitl_metadata["work_item_id"].astext == wi,
                HitlRequest.hitl_metadata["work_type"].astext == work_type,
            ).order_by(HitlRequest.created_at.desc()).limit(1)
        )
    ).first()

    if row is not None:
        req_id, req_status, responded_by, orig_actor_id = row[0], row[1], row[2], row[3]
        if req_status == "approved":
            # S-GATE-3 ①: self-approval 차단(§3d hard) — 승인자(responded_by)가 원 트리거 actor
            # (park 시 metadata.actor_id)와 동일하면 거부(다른 승인자 필요). 둘 다 known·동일일 때만.
            if (
                responded_by is not None
                and orig_actor_id is not None
                and str(responded_by) == str(orig_actor_id)
            ):
                logger.warning(
                    "gate_enforced org=%s work=%s outcome=blocked_self_approval request=%s actor=%s",
                    org_id, work_type, req_id, orig_actor_id,
                )
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "GATE_SELF_APPROVAL",
                        "work_type": work_type,
                        "level": "ask",
                        "request_id": str(req_id),
                        "requires_human": True,
                        "message": f"{work_type} 승인자가 요청자와 동일 — self-approval 금지(다른 승인자 필요).",
                    },
                )
            logger.info(
                "gate_enforced org=%s work=%s level=ask outcome=resumed approved_request=%s",
                org_id, work_type, req_id,
            )
            return
        if req_status == "rejected":
            logger.info(
                "gate_enforced org=%s work=%s level=ask outcome=blocked_rejected request=%s",
                org_id, work_type, req_id,
            )
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "GATE_REJECTED",
                    "work_type": work_type,
                    "level": "ask",
                    "request_id": str(req_id),
                    "requires_human": True,
                    "message": f"{work_type} 전이가 거부됨(rejected) — 차단 유지.",
                },
            )
        # pending — 기존 request 재사용(중복 park 방지).
        logger.info(
            "gate_enforced org=%s work=%s level=ask outcome=ask_pending request_id=%s",
            org_id, work_type, req_id,
        )
        raise HTTPException(
            status_code=409,
            detail={
                "code": "GATE_ASK",
                "work_type": work_type,
                "level": "ask",
                "request_id": str(req_id),
                "requires_human": True,
                "message": f"{work_type} 전이는 사람 승인 대기(HITL).",
            },
        )

    # 결정 이력 없음 → 신규 pending park. agent_id·requested_for 는 NOT NULL — v1 은 actor 멤버 id
    # 사용(self-approval 정교화는 S-GATE-3·§6-5).
    req = HitlRequest(
        org_id=org_id,
        project_id=project_id or org_id,  # project_id NOT NULL — 오버라이드 없으면 org 단위 표기
        agent_id=actor_id or org_id,
        request_type=_GATE_REQUEST_TYPE,
        title=f"승인 필요: {work_item_title or wi} → {work_type}",
        prompt=f"{work_type} 전이에 사람 승인이 필요합니다(게이트 레벨 ask).",
        requested_for=actor_id or org_id,
        status="pending",
        hitl_metadata={
            "work_item_id": wi,
            "work_type": work_type,
            "actor_id": str(actor_id) if actor_id else None,
            "actor_type": actor_type,
        },
    )
    session.add(req)
    await session.commit()  # raise 전 persist(_preflight_merge_gate 동형·get_db 예외 rollback 대비)
    await session.refresh(req)
    logger.info(
        "gate_enforced org=%s work=%s level=ask outcome=ask_queued request_id=%s",
        org_id, work_type, req.id,
    )
    raise HTTPException(
        status_code=409,
        detail={
            "code": "GATE_ASK",
            "work_type": work_type,
            "level": "ask",
            "request_id": str(req.id),
            "requires_human": True,
            "message": f"{work_type} 전이는 사람 승인 대기(HITL).",
        },
    )
