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
from app.services.gate_config import resolve_gate_level

logger = logging.getLogger(__name__)

_GATE_REQUEST_TYPE = "gate_approval"


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
    level = await resolve_gate_level(
        session, org_id=org_id, project_id=project_id,
        work_type=work_type, actor_type=actor_type or "human",
    )
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
    # §6-2(A): 동일 work_item 의 승인된 gate_approval 있으면 통과(승인 후 재시도 통과).
    approved = (
        await session.execute(
            select(HitlRequest.id).where(
                HitlRequest.org_id == org_id,
                HitlRequest.request_type == _GATE_REQUEST_TYPE,
                HitlRequest.status == "approved",
                HitlRequest.deleted_at.is_(None),
                HitlRequest.hitl_metadata["work_item_id"].astext == wi,
                HitlRequest.hitl_metadata["work_type"].astext == work_type,
            ).limit(1)
        )
    ).scalar_one_or_none()
    if approved is not None:
        logger.info(
            "gate_enforced org=%s work=%s level=ask outcome=resumed approved_request=%s",
            org_id, work_type, approved,
        )
        return

    # pending 중복 방지 — 이미 있으면 그 id, 없으면 생성.
    pending = (
        await session.execute(
            select(HitlRequest.id).where(
                HitlRequest.org_id == org_id,
                HitlRequest.request_type == _GATE_REQUEST_TYPE,
                HitlRequest.status == "pending",
                HitlRequest.deleted_at.is_(None),
                HitlRequest.hitl_metadata["work_item_id"].astext == wi,
                HitlRequest.hitl_metadata["work_type"].astext == work_type,
            ).limit(1)
        )
    ).scalar_one_or_none()

    if pending is None:
        # agent_id·requested_for 는 NOT NULL — v1 은 actor 멤버 id 사용(self-approval 정교화는 S-GATE-3).
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
        pending = req.id

    logger.info(
        "gate_enforced org=%s work=%s level=ask outcome=ask_queued request_id=%s",
        org_id, work_type, pending,
    )
    raise HTTPException(
        status_code=409,
        detail={
            "code": "GATE_ASK",
            "work_type": work_type,
            "level": "ask",
            "request_id": str(pending),
            "requires_human": True,
            "message": f"{work_type} 전이는 사람 승인 대기(HITL).",
        },
    )
