"""E1-S2: Hypothesis service — CRUD·전이·링크 (블루프린트 §2.5·§2.7·§3.1).

권한 규칙(§3.1):
- owner_member_id는 반드시 type='human' resolved member(§3.1.4·§3.3.6 HUMAN_OWNER_REQUIRED).
- 휴먼 caller: owner 기본값 = 자기 resolved member id(§3.1.6).
- agent/API key caller: owner 명시 필수 + status는 'proposed'로 강제(§3.1.5·§3.3.5).
- 'active' 전이는 휴먼만(§2.5.2).
상태 전이는 모델의 is_valid_transition(§2.5)을 단일 출처로 쓴다. status/outcome_result
직접 수정은 update에서 금지 — transition endpoint 전용(§3.5.3).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.hypothesis import HYPOTHESIS_STATUSES, Hypothesis, is_valid_transition
from app.models.pm import Epic, Story

logger = logging.getLogger(__name__)
from app.repositories.hypothesis import HypothesisRepository
from app.schemas.hypothesis import (
    HypothesisCreate,
    HypothesisDraftRequest,
    HypothesisDraftResponse,
    HypothesisLinkRequest,
    HypothesisResponse,
    HypothesisTransition,
    HypothesisUnlinkRequest,
    HypothesisUpdate,
)
from app.services.member_resolver import ResolvedMember, lookup_members_by_ids

# 생성 시 허용 상태 — lifecycle 상태(measuring+)는 transition 전용.
_CREATE_STATUSES = ("proposed", "active")

# §2.7.10 legacy outcome_status → hypothesis status (조회/마이그레이션 전용). n_a → None.
_LEGACY_OUTCOME_TO_STATUS: dict[str, str] = {
    "pending": "active",
    "hit": "verified",
    "miss": "falsified",
}


class HypothesisServiceError(Exception):
    """도메인 오류 — 라우터(S3)가 code/message를 HTTPException dict-detail로 매핑한다."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def map_legacy_outcome_status(outcome_status: str | None) -> str | None:
    """§2.7.10 — legacy embedded outcome status를 hypothesis lifecycle 상태로 매핑.

    조회/마이그레이션에서만 사용. n_a(또는 미지정) → None(승격할 가설 없음).
    pending → active(실행 앵커 확정 상태로 진입), hit → verified, miss → falsified.
    """
    if outcome_status is None:
        return None
    return _LEGACY_OUTCOME_TO_STATUS.get(outcome_status)


async def _verify_human_owner(session: AsyncSession, owner_id: uuid.UUID) -> None:
    members = await lookup_members_by_ids({owner_id}, session)
    rm = members.get(owner_id)
    if rm is None or rm.type != "human":
        raise HypothesisServiceError(
            "HUMAN_OWNER_REQUIRED", "owner_member_id는 type='human' 멤버여야 합니다."
        )


async def _to_response(
    repo: HypothesisRepository, hyp
) -> HypothesisResponse:
    epic_ids = await repo.get_epic_ids(hyp.id)
    story_ids = await repo.get_story_ids(hyp.id)
    return HypothesisResponse.from_model(hyp, epic_ids, story_ids)


async def _assert_targets_same_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    epic_ids: list[uuid.UUID],
    story_ids: list[uuid.UUID],
) -> None:
    """§3.7.2 — 링크 대상 epic/story가 hypothesis와 다른 project면 거부.

    create/draft/link 공통 service 가드. 이전엔 라우터(link 라우트)에만 있어 create·draft
    경로의 add_epic_links/add_story_links가 same-org cross-project blind INSERT로 우회됐다.
    존재하지 않는 대상도 same-project 검증 불가라 거부한다(rowcount 대조).
    """
    if epic_ids:
        rows = (await session.execute(
            select(Epic.id, Epic.project_id).where(Epic.id.in_(epic_ids))
        )).all()
        if len(rows) != len(set(epic_ids)) or any(pid != project_id for _id, pid in rows):
            raise HypothesisServiceError(
                "CROSS_PROJECT_LINK_FORBIDDEN", "다른 프로젝트의 에픽에는 연결할 수 없습니다."
            )
    if story_ids:
        rows = (await session.execute(
            select(Story.id, Story.project_id).where(Story.id.in_(story_ids))
        )).all()
        if len(rows) != len(set(story_ids)) or any(pid != project_id for _id, pid in rows):
            raise HypothesisServiceError(
                "CROSS_PROJECT_LINK_FORBIDDEN", "다른 프로젝트의 스토리에는 연결할 수 없습니다."
            )


async def create_hypothesis(
    session: AsyncSession,
    org_id: uuid.UUID,
    caller: ResolvedMember,
    payload: HypothesisCreate,
) -> HypothesisResponse:
    # owner 결정 — 휴먼 caller는 self 기본, agent caller는 명시 필수.
    owner_id = payload.owner_member_id
    if owner_id is None:
        if caller.type != "human":
            raise HypothesisServiceError(
                "HUMAN_OWNER_REQUIRED", "agent caller는 휴먼 owner_member_id를 명시해야 합니다."
            )
        owner_id = caller.id
    await _verify_human_owner(session, owner_id)

    # 상태 — agent/API key는 proposed로 강제(에러 아님). 생성 허용 상태는 proposed|active.
    status = payload.status or "proposed"
    if caller.type != "human":
        status = "proposed"
    if status not in _CREATE_STATUSES:
        raise HypothesisServiceError(
            "INVALID_CREATE_STATUS", "생성 시 status는 proposed|active만 허용됩니다."
        )

    # cross-project epic/story 링크 차단(§3.7.2) — repo.create 전이라 거부 시 orphan 가설 0.
    await _assert_targets_same_project(session, payload.project_id, payload.epic_ids, payload.story_ids)

    repo = HypothesisRepository(session, org_id)
    hyp = await repo.create(
        project_id=payload.project_id,
        owner_member_id=owner_id,
        created_by_member_id=caller.id,
        confirmed_by_member_id=caller.id if status == "active" else None,
        # 비-휴먼(에이전트/API-key) caller = 초안 작성자. proposed 강제(위 `!= "human"`)와 동일
        # 술어로 정합 — API-key resolve의 type이 정확히 "agent"가 아닌 케이스(가설 1호 drafted_by
        # null 회귀)도 포착. 휴먼 직생성만 drafted_by None.
        drafted_by_member_id=caller.id if caller.type != "human" else None,
        statement=payload.statement,
        metric_definition=payload.metric_definition,
        measure_after=payload.measure_after,
        status=status,
        source_type=payload.source_type,
        source_id=payload.source_id,
        draft_metadata=payload.draft_metadata,
    )
    await repo.add_epic_links(hyp.id, payload.epic_ids, "primary")
    await repo.add_story_links(hyp.id, payload.story_ids, "supports")
    return await _to_response(repo, hyp)


async def get_hypothesis(
    session: AsyncSession, org_id: uuid.UUID, hypothesis_id: uuid.UUID
) -> HypothesisResponse:
    repo = HypothesisRepository(session, org_id)
    hyp = await repo.get(hypothesis_id)
    if hyp is None:
        raise HypothesisServiceError("HYPOTHESIS_NOT_FOUND", "가설을 찾을 수 없습니다.")
    return await _to_response(repo, hyp)


async def list_hypotheses(
    session: AsyncSession,
    org_id: uuid.UUID,
    project_id: uuid.UUID,
    *,
    status: str | None = None,
    owner_member_id: uuid.UUID | None = None,
    epic_id: uuid.UUID | None = None,
    story_id: uuid.UUID | None = None,
    limit: int = 100,
) -> list[HypothesisResponse]:
    repo = HypothesisRepository(session, org_id)
    rows = await repo.list_filtered(
        project_id=project_id,
        status=status,
        owner_member_id=owner_member_id,
        epic_id=epic_id,
        story_id=story_id,
        limit=limit,
    )
    ids = [r.id for r in rows]
    emap = await repo.get_epic_ids_map(ids)
    smap = await repo.get_story_ids_map(ids)
    return [HypothesisResponse.from_model(r, emap[r.id], smap[r.id]) for r in rows]


async def update_hypothesis(
    session: AsyncSession,
    org_id: uuid.UUID,
    caller: ResolvedMember,
    hypothesis_id: uuid.UUID,
    payload: HypothesisUpdate,
) -> HypothesisResponse:
    repo = HypothesisRepository(session, org_id)
    hyp = await repo.get(hypothesis_id)
    if hyp is None:
        raise HypothesisServiceError("HYPOTHESIS_NOT_FOUND", "가설을 찾을 수 없습니다.")

    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        raise HypothesisServiceError("NO_VALID_FIELDS", "수정할 필드가 없습니다.")
    new_owner = fields.get("owner_member_id")
    if new_owner is not None:
        await _verify_human_owner(session, new_owner)

    updated = await repo.update(hypothesis_id, **fields)
    return await _to_response(repo, updated)


async def transition_hypothesis(
    session: AsyncSession,
    org_id: uuid.UUID,
    caller: ResolvedMember,
    hypothesis_id: uuid.UUID,
    payload: HypothesisTransition,
) -> HypothesisResponse:
    repo = HypothesisRepository(session, org_id)
    hyp = await repo.get(hypothesis_id)
    if hyp is None:
        raise HypothesisServiceError("HYPOTHESIS_NOT_FOUND", "가설을 찾을 수 없습니다.")

    target = payload.status
    if target not in HYPOTHESIS_STATUSES:
        raise HypothesisServiceError("INVALID_STATUS", f"알 수 없는 상태: {target}")
    if not is_valid_transition(hyp.status, target):
        raise HypothesisServiceError(
            "INVALID_HYPOTHESIS_TRANSITION", f"불법 전이: {hyp.status} → {target}"
        )
    # 'active' 확정은 휴먼만(§2.5.2). org admin/owner 검증은 라우터(S3)에서 보강.
    if target == "active" and caller.type != "human":
        raise HypothesisServiceError(
            "HUMAN_CONFIRM_REQUIRED", "active 전이는 휴먼만 가능합니다."
        )

    updates: dict = {"status": target}
    if target == "active":
        updates["confirmed_by_member_id"] = caller.id
    if target in ("verified", "falsified") and payload.outcome_result is not None:
        updates["outcome_result"] = payload.outcome_result
    if target == "killed" and payload.note:
        updates["outcome_result"] = {**(hyp.outcome_result or {}), "reason": payload.note}
    if target == "archived":
        updates["archived_at"] = datetime.now(timezone.utc)

    updated = await repo.update(hypothesis_id, **updates)
    return await _to_response(repo, updated)


async def link_hypothesis(
    session: AsyncSession,
    org_id: uuid.UUID,
    hypothesis_id: uuid.UUID,
    payload: HypothesisLinkRequest,
) -> HypothesisResponse:
    repo = HypothesisRepository(session, org_id)
    hyp = await repo.get(hypothesis_id)
    if hyp is None:
        raise HypothesisServiceError("HYPOTHESIS_NOT_FOUND", "가설을 찾을 수 없습니다.")
    # cross-project epic/story 링크 차단(§3.7.2) — service 공통 가드(라우터 위임 제거).
    await _assert_targets_same_project(session, hyp.project_id, payload.epic_ids, payload.story_ids)
    await repo.add_epic_links(hypothesis_id, payload.epic_ids, payload.link_type or "primary")
    await repo.add_story_links(hypothesis_id, payload.story_ids, payload.link_type or "supports")
    return await _to_response(repo, hyp)


async def unlink_hypothesis(
    session: AsyncSession,
    org_id: uuid.UUID,
    hypothesis_id: uuid.UUID,
    payload: HypothesisUnlinkRequest,
) -> HypothesisResponse:
    repo = HypothesisRepository(session, org_id)
    hyp = await repo.get(hypothesis_id)
    if hyp is None:
        raise HypothesisServiceError("HYPOTHESIS_NOT_FOUND", "가설을 찾을 수 없습니다.")
    await repo.remove_epic_links(hypothesis_id, payload.epic_ids)
    await repo.remove_story_links(hypothesis_id, payload.story_ids)
    return await _to_response(repo, hyp)


async def archive_hypothesis(
    session: AsyncSession, org_id: uuid.UUID, hypothesis_id: uuid.UUID
) -> None:
    """§3.10 — hard delete가 아니라 archive(status='archived'·archived_at=now)."""
    repo = HypothesisRepository(session, org_id)
    hyp = await repo.get(hypothesis_id)
    if hyp is None:
        raise HypothesisServiceError("HYPOTHESIS_NOT_FOUND", "가설을 찾을 수 없습니다.")
    await repo.update(
        hypothesis_id, status="archived", archived_at=datetime.now(timezone.utc)
    )


# §2.2.4 statement 최대 길이(템플릿 truncate). §2.2.8 source_snapshot은 입력 일부만.
_SNAPSHOT_VALUE_MAX = 500
_DEFAULT_MEASURE_DAYS = 14


def _build_source_snapshot(context: dict | None) -> dict:
    """§2.2.8 — 원본 전체 복제 금지. context에서 title/description 일부만 truncate해 보관."""
    if not context:
        return {}
    snap: dict = {}
    for key in ("title", "description", "summary"):
        val = context.get(key)
        if isinstance(val, str) and val:
            snap[key] = val[:_SNAPSHOT_VALUE_MAX]
    return snap


def _template_statement(context: dict | None) -> str:
    """deterministic 템플릿 초안(§3.9.5). LLM draft service는 미확인이라 후속 story로 미룬다."""
    title = (context or {}).get("title")
    if isinstance(title, str) and title.strip():
        return f"{title.strip()[:120]} — 이 실행 묶음이 목표 지표를 개선한다"
    return "이 실행 묶음이 목표 지표를 개선한다"


async def draft_hypothesis(
    session: AsyncSession,
    org_id: uuid.UUID,
    caller: ResolvedMember,
    payload: HypothesisDraftRequest,
) -> HypothesisDraftResponse:
    """§3.9 — 흐름 부산물에서 AI 초안 생성. DB에 active를 만들지 않는다.

    persist=true이면 status='proposed' row만 생성(create 경로 재사용 — owner/agent 규칙 동일).
    초기에는 deterministic 템플릿(LLM 미연결). 사람이 statement/metric을 다듬고 확정한다.
    """
    statement = _template_statement(payload.context)
    metric_definition = {"metric": "outcome", "source": "manual", "target": 1, "direction": "up"}
    measure_after = datetime.now(timezone.utc) + timedelta(days=_DEFAULT_MEASURE_DAYS)
    snapshot = _build_source_snapshot(payload.context)

    # source_type='epic'/'story'면 source_id로 실 링크를 만든다. source 필드만 저장하면
    # epic 상세의 가설 리스트(hypothesis_epic_links 조인)에 안 떠 초안→확인이 무의미해진다.
    epic_ids = [payload.source_id] if payload.source_type == "epic" else []
    story_ids = [payload.source_id] if payload.source_type == "story" else []

    hyp_resp: HypothesisResponse | None = None
    if payload.persist:
        hyp_resp = await create_hypothesis(
            session, org_id, caller,
            HypothesisCreate(
                project_id=payload.project_id,
                statement=statement,
                metric_definition=metric_definition,
                measure_after=measure_after,
                status="proposed",
                epic_ids=epic_ids,
                story_ids=story_ids,
                source_type=payload.source_type,
                source_id=payload.source_id,
                draft_metadata={"template": True, "source_snapshot": snapshot},
            ),
        )
    return HypothesisDraftResponse(
        statement=statement,
        metric_definition=metric_definition,
        measure_after=measure_after,
        source_snapshot=snapshot,
        confidence=None,
        requires_confirmation=True,
        hypothesis=hyp_resp,
    )


# ── L4: dispatch hypothesis anchor (§5) ──────────────────────────────────────
_ANCHOR_STATEMENT_MAX = 160


def build_anchor_dict(hyp) -> dict:
    """§5.1.1 payload anchor — metric/target/direction은 metric_definition에서 평탄화."""
    md = hyp.metric_definition or {}
    return {
        "id": str(hyp.id),
        "statement": hyp.statement,
        "status": hyp.status,
        "metric": md.get("metric"),
        "target": md.get("target"),
        "direction": md.get("direction"),
        "measure_after": hyp.measure_after.isoformat() if hyp.measure_after else None,
    }


def format_anchor_line(anchor: dict) -> str:
    """§5.3 content 한 줄: `[hypothesis] {statement} — {metric} {direction} {target} by {date}`.

    statement는 160자 truncate. metric/target/measure_after가 없으면 해당 절을 생략한다.
    """
    stmt = (anchor.get("statement") or "")[:_ANCHOR_STATEMENT_MAX]
    metric = anchor.get("metric") or ""
    direction = anchor.get("direction") or ""
    target = anchor.get("target")
    measure_after = anchor.get("measure_after")
    line = f"[hypothesis] {stmt}"
    metric_part = " ".join(str(p) for p in (metric, direction, target) if p not in (None, "")).strip()
    if metric_part:
        line += f" — {metric_part}"
    if isinstance(measure_after, str) and measure_after:
        line += f" by {measure_after[:10]}"
    return line


async def resolve_dispatch_anchor(
    session: AsyncSession,
    org_id: uuid.UUID,
    entity_type: str,
    entity_id: uuid.UUID,
) -> dict | None:
    """dispatch 대상의 대표 가설 anchor dict(§5.2). 없으면 None(에픽/스토리 외엔 항상 None)."""
    repo = HypothesisRepository(session, org_id)
    hyp = await repo.resolve_primary_anchor(entity_type, entity_id)
    # type 가드: anchor는 dispatch의 optional 보강이므로, resolve가 Hypothesis가 아닌 값을
    # 내면 dispatch(critical path)를 crash시키지 말고 graceful하게 anchor 없이 진행한다.
    # (실 DB는 Hypothesis|None만 반환 — 비-모델은 비정상 신호라 warning.)
    if not isinstance(hyp, Hypothesis):
        if hyp is not None:
            logger.warning(
                "resolve_dispatch_anchor: non-Hypothesis result %r for %s %s — anchor skipped",
                type(hyp).__name__, entity_type, entity_id,
            )
        return None
    return build_anchor_dict(hyp)
