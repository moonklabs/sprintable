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
from app.models.pm import Epic, Sprint, Story

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


async def _verify_human_owner(session: AsyncSession, org_id: uuid.UUID, owner_id: uuid.UUID) -> None:
    """prod 핫픽스(S20 전수스캔 MUST): 이전엔 org_id 검증이 없어(``lookup_members_by_ids``가
    org 필터 없이 순수 id로만 조회) caller가 임의 org의 human을 owner_member_id로 지정할 수
    있었다(cross-org 오귀속 — 데이터 유출은 아니나 신원 스푸핑). 조회된 멤버가 caller의 org
    소속인지 검증한다."""
    members = await lookup_members_by_ids({owner_id}, session)
    rm = members.get(owner_id)
    if rm is None or rm.type != "human" or rm.org_id != org_id:
        raise HypothesisServiceError(
            "HUMAN_OWNER_REQUIRED", "owner_member_id는 caller와 동일 org의 type='human' 멤버여야 합니다."
        )


async def _to_response(
    repo: HypothesisRepository, hyp
) -> HypothesisResponse:
    epic_ids = await repo.get_epic_ids(hyp.id)
    story_ids = await repo.get_story_ids(hyp.id)
    sprint_id = await repo.get_sprint_id(hyp.id)
    return HypothesisResponse.from_model(hyp, epic_ids, story_ids, sprint_id)


async def _assert_targets_same_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    epic_ids: list[uuid.UUID],
    story_ids: list[uuid.UUID],
    sprint_id: uuid.UUID | None = None,
) -> None:
    """§3.7.2 — 링크 대상 epic/story/sprint가 hypothesis와 다른 project면 거부.

    create/draft/link 공통 service 가드. 이전엔 라우터(link 라우트)에만 있어 create·draft
    경로의 add_epic_links/add_story_links가 same-org cross-project blind INSERT로 우회됐다.
    존재하지 않는 대상도 same-project 검증 불가라 거부한다(rowcount 대조). sprint_id는
    a4acc4d0(N:1)이 동일 원칙으로 확장 — org 스코프도 여기서 겸함(project는 org 1:1이라
    다른 org의 sprint_id를 넣어도 project_id 불일치로 걸림, anti-IDOR).
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
    if sprint_id is not None:
        sprint_project_id = await session.scalar(
            select(Sprint.project_id).where(Sprint.id == sprint_id)
        )
        if sprint_project_id != project_id:
            raise HypothesisServiceError(
                "CROSS_PROJECT_LINK_FORBIDDEN", "다른 프로젝트의 스프린트에는 연결할 수 없습니다."
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
    await _verify_human_owner(session, org_id, owner_id)

    # 상태 — agent/API key는 proposed로 강제(에러 아님). 생성 허용 상태는 proposed|active.
    status = payload.status or "proposed"
    if caller.type != "human":
        status = "proposed"
    if status not in _CREATE_STATUSES:
        raise HypothesisServiceError(
            "INVALID_CREATE_STATUS", "생성 시 status는 proposed|active만 허용됩니다."
        )

    # cross-project epic/story/sprint 링크 차단(§3.7.2·a4acc4d0 까심 RC①) — repo.create 전이라
    # 거부 시 orphan 가설 0. sprint_id도 epic_ids/story_ids와 대칭으로 create-time 링크 지원
    # (sprint-open 선언 흐름 + story 3 seed가 create-time 링크를 요구 — 이전엔 /links 전용이라
    # create 시 sprint_id를 줘도 silent drop됐다).
    await _assert_targets_same_project(
        session, payload.project_id, payload.epic_ids, payload.story_ids, payload.sprint_id
    )

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
    if payload.sprint_id is not None:
        await repo.set_sprint_link(hyp.id, payload.sprint_id, "declared")

    # E-LOOP-LEDGER P1-S4: statement를 embeddings 큐에 pending으로 등록(네트워크 I/O 0 —
    # 실제 임베딩은 P1-S3 cron이 처리). score_hypotheses/attribute_loop_outcome과 동형 배선.
    from app.services.embedding_enqueue import build_hypothesis_embedding_text, enqueue_embedding
    await enqueue_embedding(
        session, org_id, hyp.project_id, "hypothesis", hyp.id,
        build_hypothesis_embedding_text(hyp.statement), created_by_member_id=caller.id,
    )

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
    sprint_id: uuid.UUID | None = None,
    limit: int = 100,
) -> list[HypothesisResponse]:
    repo = HypothesisRepository(session, org_id)
    rows = await repo.list_filtered(
        project_id=project_id,
        status=status,
        owner_member_id=owner_member_id,
        epic_id=epic_id,
        story_id=story_id,
        sprint_id=sprint_id,
        limit=limit,
    )
    ids = [r.id for r in rows]
    emap = await repo.get_epic_ids_map(ids)
    smap = await repo.get_story_ids_map(ids)
    spmap = await repo.get_sprint_ids_map(ids)
    return [HypothesisResponse.from_model(r, emap[r.id], smap[r.id], spmap[r.id]) for r in rows]


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
    # sprint_id는 hypotheses 컬럼이 아니라 링크 테이블 행(a4acc4d0 까심 RC①) — repo.update()에
    # 그대로 넘기면 존재하지 않는 컬럼이라 silent no-op이 된다. 별도 경로(set/remove_sprint_link)로
    # 분리하고, sprint_id만 patch돼도(exclude_unset 시맨틱) NO_VALID_FIELDS에 걸리지 않게
    # 위 dict 생성 이후에 pop한다.
    sprint_id_provided = "sprint_id" in fields
    sprint_id = fields.pop("sprint_id", None)
    new_owner = fields.get("owner_member_id")
    if new_owner is not None:
        await _verify_human_owner(session, org_id, new_owner)
    # cross-project 가드는 어떤 컬럼 mutation보다 먼저 — 거부 시 부분 update 0(create 경로와 동형).
    if sprint_id_provided and sprint_id is not None:
        await _assert_targets_same_project(session, hyp.project_id, [], [], sprint_id)

    updated = hyp
    if fields:
        updated = await repo.update(hypothesis_id, **fields)
    if sprint_id_provided:
        if sprint_id is not None:
            await repo.set_sprint_link(hypothesis_id, sprint_id, "declared")
        else:
            await repo.remove_sprint_link(hypothesis_id)

    # P1-S4: statement가 바뀌면 재임베딩 큐잉(content_hash가 변경 없는 재저장은 no-op으로 걸러줌).
    if "statement" in fields:
        from app.services.embedding_enqueue import build_hypothesis_embedding_text, enqueue_embedding
        await enqueue_embedding(
            session, org_id, updated.project_id, "hypothesis", updated.id,
            build_hypothesis_embedding_text(updated.statement), created_by_member_id=caller.id,
        )

    return await _to_response(repo, updated)


async def transition_hypothesis(
    session: AsyncSession,
    org_id: uuid.UUID,
    caller: ResolvedMember,
    hypothesis_id: uuid.UUID,
    payload: HypothesisTransition,
    via_gate: bool = False,
) -> HypothesisResponse:
    """hypothesis status 전이. ``via_gate=True`` = Decision Gate 승인이 적용하는 경로로, S23 overlay
    재진입(re-gate 루프)을 막고 inline native 전이로 직행한다(caller=gate approver·human)."""
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
    # ⭐E-DG S23: proposed→active line overlay. enforcing 라인이면 human-gate 생성·proposed 유지
    # (agent-drafted hyp 의 confirm 대기가 가시 gate 가 되고 승인 시 자동 재개). default-off/plain/
    # 엔진실패 → 아래 inline human-only 로 폴백(byte-동일·agent 차단 유지·⚠️fail-open=active 통과 아님).
    if target == "active" and hyp.status == "proposed" and not via_gate:
        _decision = None
        try:
            from app.services.workflow_line_engine import evaluate_line_for_transition
            _decision = await evaluate_line_for_transition(
                session, org_id=org_id, project_id=hyp.project_id,
                entity_type="hypothesis", entity_id=hyp.id,
                from_status="proposed", to_status="active",
                actor_id=caller.id, actor_type=caller.type,
            )
        except Exception:  # noqa: BLE001 — fail-open: 엔진 실패는 inline human-only 폴백(agent 차단 유지).
            _decision = None
        if _decision is not None and not _decision.proceeds:
            # enforcing: human-gate pending. hyp proposed 유지·gate 가 confirm 대기 가시화(에러 아님).
            await session.commit()  # gate/step_run 보존(stories.py:736 패턴·예외 시 rollback 방지).
            return await _to_response(repo, hyp)

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

    if target in ("verified", "falsified"):
        # E-LOOP-LEDGER S19: hypothesis_scorer.score_hypotheses(cron·GA4/internal_ops 전용)가
        # 해소 직후 부르는 것과 동일한 다운스트림을 이 경로(수동 transition·source 무관)에도
        # 배선한다 — 이 호출이 없으면 cron이 자동채점 안 하는 source(manual 등)로 해소된 가설이나
        # 사람이 직접 transition으로 해소한 가설은 trust verdict(HO-S4)도 loop 귀속(S7)도 조용히
        # 스킵됐다(진짜 갭). source-agnostic: GA4/internal_ops/manual 어느 경로든 verified/falsified
        # 도달 시 항상 같은 다운스트림이 돈다("통합 0개여도 loop 완결" 실증).
        from app.services.hypothesis_outcome_verdict import record_outcome_verdicts
        from app.services.loop_outcome_attribution import attribute_loop_outcome

        await record_outcome_verdicts(session, updated)
        await attribute_loop_outcome(session, updated)

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
    # cross-project epic/story/sprint 링크 차단(§3.7.2·a4acc4d0) — service 공통 가드(라우터 위임 제거).
    await _assert_targets_same_project(
        session, hyp.project_id, payload.epic_ids, payload.story_ids, payload.sprint_id
    )
    await repo.add_epic_links(hypothesis_id, payload.epic_ids, payload.link_type or "primary")
    await repo.add_story_links(hypothesis_id, payload.story_ids, payload.link_type or "supports")
    if payload.sprint_id is not None:
        await repo.set_sprint_link(hypothesis_id, payload.sprint_id, payload.link_type or "declared")
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
    if payload.unlink_sprint:
        await repo.remove_sprint_link(hypothesis_id)
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
    """deterministic 템플릿 초안(§3.9.5) — gen-LLM(S25) 미가용/실패 시 fallback."""
    title = (context or {}).get("title")
    if isinstance(title, str) and title.strip():
        return f"{title.strip()[:120]} — 이 실행 묶음이 목표 지표를 개선한다"
    return "이 실행 묶음이 목표 지표를 개선한다"


_DRAFT_INSTRUCTION = (
    "다음은 새 가설(hypothesis)의 소재가 될 작업 맥락이다. 이 맥락에 명시된 내용만 근거로, "
    '"실행하면 목표 지표가 개선될 것이다" 형태의 검증 가능한 가설 문장을 한국어 1문장으로 '
    "작성하라. 맥락에 없는 지표/숫자/사실을 추정하거나 새로 만들어내지 마라. 사람이 검토·수정할 "
    "초안이니 간결하고 구체적으로 작성하라."
)


def _build_draft_prompt(context: dict | None) -> str | None:
    """S15: 맥락(title/description/summary) 전무면 None — 근거 없이 LLM에 지어내라고
    시키지 않는다(S26/S27과 동형 원칙: 없는 사실을 만들 근거 자체를 안 준다)."""
    if not context:
        return None
    title, description, summary = context.get("title"), context.get("description"), context.get("summary")
    if not any(isinstance(v, str) and v.strip() for v in (title, description, summary)):
        return None
    lines = [_DRAFT_INSTRUCTION, ""]
    if title:
        lines.append(f"제목: {title}")
    if description:
        lines.append(f"설명: {description}")
    if summary:
        lines.append(f"요약: {summary}")
    lines.extend(["", "가설 문장(1문장):"])
    return "\n".join(lines)


def _draft_statement(context: dict | None) -> tuple[str, bool]:
    """S15 근본 구현: gen-LLM(S25)으로 맥락 기반 초안 시도 → 맥락 부족/LLM 미가용/실패 시
    기존 deterministic 템플릿으로 graceful fallback(무손상, S25/S26/S27과 동일 격리 철학).
    반환 = (statement, llm_generated 여부 — draft_metadata에 기록해 추후 추적 가능)."""
    prompt = _build_draft_prompt(context)
    if prompt is not None:
        try:
            # Gemini 피벗(2026-07-03): moonklabs org GCP credit 미포함으로 Claude 경로
            # (generate_text_claude) 은퇴 → generate_text(Gemini)로 복귀(synthesis/
            # recommendation과 동일 모델 배선).
            from app.services.llm_client import generate_text

            generated = generate_text(prompt)
            if generated and generated.strip():
                return generated.strip(), True
        except Exception as exc:
            logger.warning("hypothesis draft: LLM 초안 실패(템플릿 fallback): %s", exc)
    return _template_statement(context), False


async def draft_hypothesis(
    session: AsyncSession,
    org_id: uuid.UUID,
    caller: ResolvedMember,
    payload: HypothesisDraftRequest,
) -> HypothesisDraftResponse:
    """§3.9 — 흐름 부산물에서 AI 초안 생성. DB에 active를 만들지 않는다(호출부는 항상
    create_hypothesis를 통해서만 persist하고, status='proposed' 강제는 그 함수의 기존 정책
    그대로 — agent caller는 절대 active를 만들 수 없다. "돕되 대체 안 함": 자동초안은 제안일
    뿐, 인간이 검토·수정·confirm(별도 human-only transition)해야 active가 된다).

    persist=true이면 status='proposed' row만 생성(create 경로 재사용 — owner/agent 규칙 동일).
    S15: gen-LLM(S25)으로 statement 초안 시도 → 미가용/실패 시 기존 deterministic 템플릿으로
    graceful fallback. metric_definition/measure_after는 여전히 고정값(사람이 다듬는 전제).
    """
    statement, llm_generated = _draft_statement(payload.context)
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
                draft_metadata={
                    "generation_method": "llm" if llm_generated else "template",
                    "source_snapshot": snapshot,
                },
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


async def resolve_dispatch_context_pack(
    session: AsyncSession,
    org_id: uuid.UUID,
    entity_type: str,
    entity_id: uuid.UUID,
) -> str | None:
    """E-LOOP-LEDGER P1-S11(+S11b): dispatch 대상의 Context Pack(S7이 조립한 markdown brief) —
    복리 조직기억이 에이전트에게 실제로 전달되는 지점(crux GO 2026-07-02).

    entity_type=='hypothesis'는 직접 경로. story/epic은 resolve_primary_anchor(hypothesis_anchor
    와 동일 SSOT — story link primary 우선→없으면 story의 epic primary로 fallback·epic은 epic
    link primary)로 대표 hypothesis 1건을 먼저 해소한 뒤 동일 loop 조회로 합류한다(S11b, 간접
    entity 커버리지). sprint/doc 등 그 외는 anchor 메커니즘 자체가 커버하지 않는 범위라 동형으로
    스코프 밖(None, 쿼리 0).

    해소된 hypothesis에 연결된 loop 중 최신(created_at desc)·abandoned 제외 1개를 선택 — 여러
    loop이 있을 수 있어(1:0..N) 결정론적 단일 선택이 필요하다.

    데이터 소스는 선택된 loop의 brief_doc_id(S7이 draft→briefing 전이 시 조립한 Doc)를 그대로
    재사용한다 — 재검색(embed_client 호출) 안 함. dispatch는 사용자가 응답을 기다리는 요청이
    아니라(S6 검색과 대비) latency/비용을 새로 들일 이유가 없다. brief_doc_id가 없으면(loop이
    아직 briefing 전이 전) None(hypothesis_anchor의 null-fallback과 동형 — 재검색으로 억지로
    채우지 않는다)."""
    if entity_type == "hypothesis":
        hypothesis_id = entity_id
    elif entity_type in ("story", "epic"):
        # 까심 QA RC(2026-07-02): Context Pack은 dispatch(critical path)의 optional 보강이라
        # 이 해소가 실패/예상외 타입을 내도 dispatch 자체를 절대 깨면 안 된다(resolve_dispatch_anchor
        # 의 isinstance 방어와 동일 원칙 + 쿼리 자체의 예외까지 try/except로 추가 방어 — anchor
        # 쪽은 쿼리 예외 방어가 없어 이번에 같은 취약점이 있었음이 드러남).
        try:
            repo = HypothesisRepository(session, org_id)
            anchor_hyp = await repo.resolve_primary_anchor(entity_type, entity_id)
        except Exception as exc:
            logger.warning(
                "resolve_dispatch_context_pack: anchor 해소 실패(생략 처리) %s %s: %s",
                entity_type, entity_id, exc,
            )
            return None
        if not isinstance(anchor_hyp, Hypothesis):
            if anchor_hyp is not None:
                logger.warning(
                    "resolve_dispatch_context_pack: non-Hypothesis anchor %r for %s %s — 생략",
                    type(anchor_hyp).__name__, entity_type, entity_id,
                )
            return None
        hypothesis_id = anchor_hyp.id
    else:
        return None

    from app.models.doc import Doc
    from app.models.loop import LoopRun

    loop = (await session.execute(
        select(LoopRun)
        .where(
            LoopRun.org_id == org_id,
            LoopRun.hypothesis_id == hypothesis_id,
            LoopRun.status != "abandoned",
            LoopRun.deleted_at.is_(None),
        )
        .order_by(LoopRun.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    if loop is None or loop.brief_doc_id is None:
        return None

    doc = (await session.execute(
        select(Doc).where(Doc.id == loop.brief_doc_id, Doc.org_id == org_id, Doc.deleted_at.is_(None))
    )).scalar_one_or_none()
    return doc.content if doc is not None else None
