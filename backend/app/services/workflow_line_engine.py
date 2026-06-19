"""E-DECISION-GATE S3: 전이=step 실행 엔진 (P0-1 fail-open core).

``evaluate_line_for_transition()`` 는 board status 전이 직전에 호출돼, 활성 워크플로우 라인이
있으면 그 step 을 평가한다. ⭐**핵심 불변식(P0-1)**: 이 엔진의 *어떤* 내부 실패도 board status
전이를 freeze해선 안 된다. resolver/config/trust 예외는 router 밖으로 나가지 않고
``engine_failed`` + ``degraded_to_plain`` 로 기록된 뒤 ``plain_transition`` 으로 graceful degrade
한다(보드 freeze·dispatch P0 cascade 방지).

S3 범위 = fail-open 코어 + shadow 모드. 모드:
- 활성 라인 없음 / ``off`` / 매칭 step 없음 → ``plain_transition`` (step_run 미생성).
- ``shadow`` / ``advisory`` → step_run + would-decision 기록, 전이 **비차단**(``advisory_only``).
- ``enforcing`` → 정적 policy block(step config ``enforcement='block'``)은 ``blocked_by_policy``
  (전이 차단·예외와 명확히 구분, fail-open 대상 아님). 그 외 enforcing(gate/route 실집행)은 trust
  resolver(S4)·gate 통합(S5)·runtime mode(S18) 도입 전까지 dormant → step_run 기록 후 비차단.
- 내부 예외 → ``engine_failed`` + ``degraded_to_plain`` → plain.

policy block(``blocked_by_policy``)은 정상 decision이므로 fail-open(예외 처리)과 섞지 않는다.
"""
import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workflow_line import (
    WorkflowLineDefinition,
    WorkflowLineDefinitionVersion,
    WorkflowLineStepRun,
)
from app.services.workflow_line_resolver import resolve_routing_context

_TERMINAL_PROCEED_MODES = frozenset({"plain_transition", "advisory_only", "engine_failed"})


@dataclass
class LineDecision:
    """엔진 평가 결과. ``mode`` 가 board 전이 진행/차단을 가른다."""

    mode: str  # plain_transition | advisory_only | gate_pending | blocked_by_policy | engine_failed
    status_to_apply: str | None
    gate_id: uuid.UUID | None = None
    step_run_id: uuid.UUID | None = None
    blocking_reason: str | None = None
    http_status: int | None = None
    degraded_to_plain: bool = False

    @property
    def proceeds(self) -> bool:
        """board status 전이를 진행해도 되는지(set_status 호출 여부)."""
        return self.mode in _TERMINAL_PROCEED_MODES


def _plain() -> LineDecision:
    return LineDecision(mode="plain_transition", status_to_apply=None)


async def _active_definition(
    session: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID | None, entity_type: str
) -> WorkflowLineDefinition | None:
    """(org, project, entity) 활성 라인. project override 우선, 없으면 org-default."""
    r = await session.execute(
        select(WorkflowLineDefinition).where(
            WorkflowLineDefinition.org_id == org_id,
            WorkflowLineDefinition.entity_type == entity_type,
            WorkflowLineDefinition.is_active.is_(True),
        )
    )
    candidates = r.scalars().all()
    if not candidates:
        return None
    if project_id is not None:
        for d in candidates:
            if d.project_id == project_id:
                return d
    for d in candidates:
        if d.project_id is None:
            return d
    return None


async def _published_config(
    session: AsyncSession, definition: WorkflowLineDefinition
) -> dict[str, Any]:
    r = await session.execute(
        select(WorkflowLineDefinitionVersion).where(
            WorkflowLineDefinitionVersion.line_definition_id == definition.id,
            WorkflowLineDefinitionVersion.status == "published",
        ).order_by(WorkflowLineDefinitionVersion.version.desc()).limit(1)
    )
    version = r.scalar_one_or_none()
    return dict(version.config) if version and isinstance(version.config, dict) else {}


def _match_step(config: dict[str, Any], from_status: str | None, to_status: str) -> dict | None:
    for step in config.get("steps") or []:
        if not isinstance(step, dict):
            continue
        if step.get("to_status") == to_status and step.get("from_status") in (from_status, None):
            return step
    return None


async def evaluate_line_for_transition(
    session: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
    entity_type: str,
    entity_id: uuid.UUID,
    from_status: str | None,
    to_status: str,
    actor_id: uuid.UUID | None = None,
    actor_type: str | None = None,
    transition_id: str | None = None,
) -> LineDecision:
    """전이 직전 라인 평가. ⭐절대 예외를 raise하지 않는다(P0-1 fail-open)."""
    transition_id = transition_id or uuid.uuid4().hex
    correlation_id = uuid.uuid4()
    try:
        definition = await _active_definition(session, org_id, project_id, entity_type)
        if definition is None:
            return _plain()  # 활성 라인 없음 = 현 default-off 현실 → 무영향

        config = await _published_config(session, definition)
        mode = str(config.get("rollout_mode") or "shadow").strip()
        if mode == "off":
            return _plain()

        step = _match_step(config, from_status, to_status)
        if step is None:
            return _plain()  # 이 전이를 거버닝하는 step 없음 → plain

        # S4: routing_context + trust snapshot 구성. ⭐step_run insert *전에* 계산한다
        # (trust-before-capture — autoflush 가 pending step_run 을 trust 쿼리에 끌어들이는 것 방지).
        # resolver 예외도 바깥 try/except 가 잡아 engine_failed→plain 으로 degrade(fail-open 유지).
        routing_context = await resolve_routing_context(
            session, org_id, entity_type=entity_type, entity_id=entity_id,
            actor_member_id=actor_id, actor_type=actor_type,
        )
        trust_snapshot = routing_context.get("trust") if isinstance(routing_context, dict) else None

        # enforcing + 정적 policy block → blocked_by_policy(전이 차단·예외 아님·⑤).
        if mode == "enforcing" and step.get("enforcement") == "block":
            step_run = await _record_step_run(
                session, org_id=org_id, project_id=project_id, definition=definition, step=step,
                entity_type=entity_type, entity_id=entity_id, from_status=from_status,
                to_status=to_status, status="blocked_by_policy", run_mode="blocked_by_policy",
                routing_decision="block", routing_reason="static policy block",
                routing_context=routing_context, trust_snapshot=trust_snapshot,
                transition_id=transition_id, correlation_id=correlation_id,
            )
            return LineDecision(
                mode="blocked_by_policy", status_to_apply=None,
                step_run_id=step_run.id if step_run else None,
                blocking_reason="workflow line policy blocks this transition", http_status=409,
            )

        # shadow/advisory(+ S3 dormant enforcing) → step_run 기록 후 비차단.
        step_run = await _record_step_run(
            session, org_id=org_id, project_id=project_id, definition=definition, step=step,
            entity_type=entity_type, entity_id=entity_id, from_status=from_status,
            to_status=to_status, status="routing_resolved", run_mode="advisory_only",
            routing_decision="would_" + str(step.get("step_type") or "advisory"),
            routing_reason=f"shadow/advisory record (mode={mode})",
            routing_context=routing_context, trust_snapshot=trust_snapshot,
            transition_id=transition_id, correlation_id=correlation_id,
        )
        return LineDecision(
            mode="advisory_only", status_to_apply=to_status,
            step_run_id=step_run.id if step_run else None,
        )
    except Exception as exc:  # noqa: BLE001 — ⭐P0-1: 어떤 예외도 전이를 막지 않는다.
        # engine_failed step_run 기록은 best-effort(기록 실패도 전이 비차단·SME 체크포인트).
        step_run_id = None
        try:
            sr = await _record_step_run(
                session, org_id=org_id, project_id=project_id, definition=None, step=None,
                entity_type=entity_type, entity_id=entity_id, from_status=from_status,
                to_status=to_status, status="engine_failed", run_mode="engine_failed",
                failure_class=type(exc).__name__, failure_message=str(exc)[:500],
                degraded_to_plain=True, transition_id=transition_id, correlation_id=correlation_id,
            )
            step_run_id = sr.id if sr else None
        except Exception:  # noqa: BLE001 — 기록 실패도 무시(전이 우선).
            step_run_id = None
        return LineDecision(
            mode="engine_failed", status_to_apply=to_status, step_run_id=step_run_id,
            degraded_to_plain=True, blocking_reason=None,
        )


async def _record_step_run(
    session: AsyncSession, *, org_id, project_id, definition, step, entity_type, entity_id,
    from_status, to_status, status, run_mode, transition_id, correlation_id,
    routing_decision=None, routing_reason=None, failure_class=None, failure_message=None,
    degraded_to_plain=False, routing_context=None, trust_snapshot=None,
) -> WorkflowLineStepRun | None:
    """step_run 기록. 호출자가 best-effort 로 감싼다(기록 실패도 전이 비차단)."""
    sr = WorkflowLineStepRun(
        org_id=org_id, project_id=project_id or org_id,  # project_id NN — org-level 라인은 org_id로 대체 표기
        line_definition_id=definition.id if definition is not None else None,
        entity_type=entity_type, entity_id=entity_id, from_status=from_status, to_status=to_status,
        status=status, mode=run_mode, routing_decision=routing_decision, routing_reason=routing_reason,
        routing_context=routing_context if routing_context is not None else {},  # S4: trust-routing 입력
        trust_snapshot=trust_snapshot if trust_snapshot is not None else {},     # S4: outcome-trust(이력만)
        effective_step_type=(step or {}).get("step_type") if step else None,
        failure_class=failure_class, failure_message=failure_message, degraded_to_plain=degraded_to_plain,
        correlation_id=correlation_id, transition_id=transition_id,
    )
    # ⭐P0-1: step_run insert 를 SAVEPOINT 로 격리. flush 실패(active partial unique 충돌=double-fire·
    # 제약 위반 등)가 outer 트랜잭션을 aborted 로 poison하면, 엔진이 engine_failed 를 반환해도 이후
    # repo.set_status() 가 PendingRollbackError 로 깨져 board 전이가 freeze된다(레드팀 적출). savepoint 면
    # 실패가 nested tx 로만 롤백되고 outer 는 보존돼 set_status 가 정상 진행한다.
    try:
        async with session.begin_nested():
            session.add(sr)
            await session.flush()
    except Exception:  # noqa: BLE001 — 기록 실패는 격리·비차단. 재flush 방지 위해 expunge.
        try:
            session.expunge(sr)
        except Exception:  # noqa: BLE001
            pass
        return None
    return sr
