"""E-DECISION-GATE S2: workflow line config 거버넌스 서비스 (P0-4).

라인 config 의 draft/publish lifecycle + publish lint(hard-fail) + publish gate(승인 거버넌스).
"bad config 가 published line 으로 못 들어가게" 하는 게 목적이다.

설계(PO/SME 사인오프):
- 재사용: ``Gate``(gate_type='workflow_config_publish') · ``gate_service.create_gate``(idempotent +
  ``resolve_disposition`` 4-tier precedence) · gate disposition precedence 철학은
  ``app/services/gate_resolver.py`` 의 member_override→role_override→org_policy→system_default 를
  그대로 따른다(신규 권한체계 0).
- 경계: S2 = config lifecycle/approval/lint + ``workflow_line_definitions`` active pointer flip.
  ``workflow_line_steps`` materialize(엔진 read-model)는 S3.
- gate 승인 → published 확정은 ``transition_gate()`` 레일 재사용 + ``complete_publish()`` 콜백
  (transition_gate 내부에 E-DG 특수분기 누적 금지 — orphan 방지).

published version/config_hash 는 immutable(수정 = 새 draft). connector allow-list lint 는 SDK
``INJECTABLE_EVENT_TYPES`` 단일출처를 기준으로 한다(parity 는 test 가 가드).
"""
import hashlib
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.gate import Gate
from app.models.participation import ParticipationRole
from app.models.workflow_line import (
    VERSION_STATUSES,
    WorkflowLineDefinition,
    WorkflowLineDefinitionVersion,
    is_valid_version_transition,
)
from app.services.gate_service import create_gate

WORKFLOW_CONFIG_PUBLISH_GATE_TYPE = "workflow_config_publish"
# Gate.work_item_type 는 String(20) — 라인 버전 식별자는 ≤20자로 유지(work_item_id=version.id).
WORKFLOW_LINE_VERSION_WORK_ITEM_TYPE = "wf_line_version"

# connector allow-list(lint ④). SDK connectors/sdk/sprintable_sse.py 의 INJECTABLE_EVENT_TYPES 단일
# 출처를 미러링한다. 드리프트는 test_workflow_line_config 의 sync-guard 가 AST 로 잡는다(어댑터
# vendoring 가드와 동일 패턴).
WORKFLOW_EVENT_ALLOWLIST = frozenset({
    "dispatched",
    "story_assigned",
    "conversation.message_created",
    "conversation:mention",
    "kickoff",
    "review_request",
    "qa_request",
    "deploy_request",
    "handoff",
})

# routing_rules 허용 field/op(arbitrary expression 금지·AC: all|any + 비교op + field allow-list).
ALLOWED_ROUTING_FIELDS = frozenset({
    "trust_score", "risk_level", "outcome_status", "entity_type", "from_status",
    "to_status", "assignee_type", "story_points", "actor_type",
})
ALLOWED_ROUTING_OPS = frozenset({"eq", "ne", "lt", "lte", "gt", "gte", "in", "not_in"})
_HUMAN_STEP_TYPES = frozenset({"human-gate", "merge-gate"})


def compute_config_hash(config: dict[str, Any]) -> str:
    """canonical JSON 의 SHA256 — config 변조 감지(immutable audit)."""
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ── publish lint (8종 hard-fail) ──────────────────────────────────────────────
def lint_config(config: dict[str, Any]) -> list[dict[str, str]]:
    """published line 에 들어가면 안 되는 config 를 hard-fail 로 적출.

    반환: 에러 리스트(빈 리스트 = pass). 각 에러 = {"rule": <code>, "detail": <msg>}.
    """
    errors: list[dict[str, str]] = []
    steps = config.get("steps") if isinstance(config, dict) else None
    if not isinstance(steps, list):
        errors.append({"rule": "no_steps", "detail": "config.steps must be a non-empty list"})
        return errors
    if not steps:
        errors.append({"rule": "no_steps", "detail": "config has no steps"})
        return errors

    non_block_exists = False
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            errors.append({"rule": "unknown_field", "detail": f"step[{i}] is not an object"})
            continue
        loc = step.get("step_key") or f"step[{i}]"
        step_type = step.get("step_type")

        # ① unknown field/op — routing_rules 의 field/op allow-list.
        for r_idx, rule in enumerate(step.get("routing_rules") or []):
            if not isinstance(rule, dict):
                errors.append({"rule": "unknown_field", "detail": f"{loc} routing_rules[{r_idx}] not an object"})
                continue
            if rule.get("mode") not in (None, "all", "any"):
                errors.append({"rule": "unknown_op", "detail": f"{loc} routing mode '{rule.get('mode')}' invalid (all|any)"})
            for cond in rule.get("conditions") or []:
                if not isinstance(cond, dict):
                    continue
                if cond.get("field") not in ALLOWED_ROUTING_FIELDS:
                    errors.append({"rule": "unknown_field", "detail": f"{loc} routing field '{cond.get('field')}' not in allow-list"})
                if cond.get("op") not in ALLOWED_ROUTING_OPS:
                    errors.append({"rule": "unknown_op", "detail": f"{loc} routing op '{cond.get('op')}' not in allow-list"})
            # ⑥ catch-all auto_route — 무조건 자동라우팅(human 우회).
            if rule.get("catch_all") and rule.get("decision") == "auto_route":
                errors.append({"rule": "catch_all_auto_route", "detail": f"{loc} has catch-all auto_route (no human path)"})

        decision_set = {(r.get("decision") if isinstance(r, dict) else None) for r in (step.get("routing_rules") or [])}
        if step_type != "advisory" and decision_set != {"block"}:
            non_block_exists = True
        if not step.get("routing_rules"):
            non_block_exists = True  # 룰 없는 step 은 plain transition(통과)

        approval = step.get("approval_policy") if isinstance(step.get("approval_policy"), dict) else {}
        if step_type in _HUMAN_STEP_TYPES:
            approvers = approval.get("approvers") or []
            # ② no approver.
            if not approvers and not approval.get("approver_role"):
                errors.append({"rule": "no_approver", "detail": f"{loc} ({step_type}) has no approver"})
            # ③ self-approval only — 승인 경로가 self 단독.
            if approval.get("self_approval") == "allow_only" or (
                approvers == ["self"] or approval.get("only_self")
            ):
                errors.append({"rule": "self_approval_only", "detail": f"{loc} permits self-approval only"})

        # ④ no fallback/deputy — human step 의 assignee 에 fallback/deputy 부재.
        assignee = step.get("assignee_policy") if isinstance(step.get("assignee_policy"), dict) else {}
        if step_type in _HUMAN_STEP_TYPES:
            if not (assignee.get("fallback") or assignee.get("deputy") or assignee.get("fallback_role")):
                errors.append({"rule": "no_fallback", "detail": f"{loc} ({step_type}) has no fallback/deputy"})

        # ⑦ high-risk timeout auto_approve.
        sla = step.get("sla_policy") if isinstance(step.get("sla_policy"), dict) else {}
        if sla.get("on_timeout") == "auto_approve" and (
            step_type in _HUMAN_STEP_TYPES or sla.get("applies_to_high_risk", True)
        ):
            errors.append({"rule": "high_risk_timeout_auto_approve", "detail": f"{loc} auto_approves on SLA timeout"})

        # ⑧ connector allow-list 밖 event type.
        for ev in _collect_event_types(step):
            if ev not in WORKFLOW_EVENT_ALLOWLIST:
                errors.append({"rule": "event_not_in_allowlist", "detail": f"{loc} event_type '{ev}' not in connector allow-list"})

    # ⑤ all transitions blocked.
    if not non_block_exists:
        errors.append({"rule": "all_transitions_blocked", "detail": "every step blocks — no forward path"})

    return errors


def _collect_event_types(step: dict[str, Any]) -> list[str]:
    evs: list[str] = []
    for key in ("on_approve", "on_reject"):
        block = step.get(key)
        if isinstance(block, dict):
            ev = block.get("emit_event") or block.get("event_type")
            if isinstance(ev, str):
                evs.append(ev)
    ev = step.get("event_type")
    if isinstance(ev, str):
        evs.append(ev)
    return evs


# ── version lifecycle ────────────────────────────────────────────────────────
async def _next_version(session: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID | None,
                        entity_type: str) -> int:
    r = await session.execute(
        select(func.max(WorkflowLineDefinitionVersion.version)).where(
            WorkflowLineDefinitionVersion.org_id == org_id,
            WorkflowLineDefinitionVersion.project_id.is_(project_id) if project_id is None
            else WorkflowLineDefinitionVersion.project_id == project_id,
            WorkflowLineDefinitionVersion.entity_type == entity_type,
        )
    )
    return (r.scalar() or 0) + 1


async def create_draft(
    session: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID | None,
    entity_type: str, config: dict[str, Any], created_by: uuid.UUID,
) -> WorkflowLineDefinitionVersion:
    """새 draft version 생성. lint 는 비차단(draft 단계서는 경고만·publish 에서 hard-fail)."""
    version_no = await _next_version(session, org_id, project_id, entity_type)
    errors = lint_config(config)
    version = WorkflowLineDefinitionVersion(
        org_id=org_id, project_id=project_id, entity_type=entity_type, version=version_no,
        status="draft", config=config, config_hash=compute_config_hash(config),
        lint_status="failed" if errors else "passed", lint_errors=errors,
        created_by_member_id=created_by,
    )
    session.add(version)
    await session.flush()
    await session.refresh(version)
    return version


async def list_versions(
    session: AsyncSession, org_id: uuid.UUID, project_id: uuid.UUID | None, entity_type: str,
) -> list[WorkflowLineDefinitionVersion]:
    """⭐S34: scope(org/project)+entity_type 의 전 버전 history(version desc). editor version-history 모드용."""
    r = await session.execute(
        select(WorkflowLineDefinitionVersion).where(
            WorkflowLineDefinitionVersion.org_id == org_id,
            WorkflowLineDefinitionVersion.project_id.is_(None) if project_id is None
            else WorkflowLineDefinitionVersion.project_id == project_id,
            WorkflowLineDefinitionVersion.entity_type == entity_type,
        ).order_by(WorkflowLineDefinitionVersion.version.desc())
    )
    return list(r.scalars().all())


async def update_draft_config(
    session: AsyncSession, version: WorkflowLineDefinitionVersion, config: dict[str, Any],
) -> WorkflowLineDefinitionVersion:
    """⭐S34: draft version 의 config in-place 갱신(editor "저장"). ⭐published 동결·draft 가변 semantics:
    ``status=='draft'`` 만 수정 가능·published/approved/rejected/retired 는 **immutable(422)**(수정=새 draft).
    config_hash + lint 재계산(create_draft 와 동일·draft 단계 lint 비차단)."""
    if version.status != "draft":
        raise ValueError(
            f"draft 만 수정 가능합니다 (현재 {version.status}·published/approved 등은 immutable·수정은 새 draft)."
        )
    errors = lint_config(config)
    version.config = config
    version.config_hash = compute_config_hash(config)
    version.lint_status = "failed" if errors else "passed"
    version.lint_errors = errors
    await session.flush()
    await session.refresh(version)
    return version


async def transition_version(
    session: AsyncSession, version: WorkflowLineDefinitionVersion, new_status: str,
) -> WorkflowLineDefinitionVersion:
    """version lifecycle 전이(거버넌스 규칙 검증)."""
    if new_status not in VERSION_STATUSES:
        raise ValueError(f"invalid version status: {new_status}")
    if not is_valid_version_transition(version.status, new_status):
        raise ValueError(f"불법 version 전이: {version.status} → {new_status}")
    version.status = new_status
    await session.flush()
    await session.refresh(version)
    return version


async def _default_role_id(session: AsyncSession, org_id: uuid.UUID) -> uuid.UUID | None:
    r = await session.execute(
        select(ParticipationRole.id).where(
            ParticipationRole.org_id == org_id, ParticipationRole.is_default.is_(True)
        ).limit(1)
    )
    return r.scalar_one_or_none()


async def request_publish(
    session: AsyncSession, org_id: uuid.UUID, version: WorkflowLineDefinitionVersion,
    member_id: uuid.UUID,
) -> tuple[WorkflowLineDefinitionVersion, Gate]:
    """publish 요청: lint hard-fail → Gate(workflow_config_publish) 생성.

    disposition allow_auto 면 gate 가 approved 로 생성되고 즉시 publish 확정,
    ask 면 pending(org owner/admin 승인 대기). lint 실패 시 ValueError(hard-fail).
    """
    errors = lint_config(version.config)
    version.lint_status = "failed" if errors else "passed"
    version.lint_errors = errors
    if errors:
        await session.flush()
        raise PublishLintError(errors)

    if version.status not in ("draft", "pending_review", "rejected"):
        raise ValueError(f"version {version.id} status {version.status} cannot request publish")
    if version.status != "pending_review":
        await transition_version(session, version, "pending_review")

    role_id = await _default_role_id(session, org_id) or uuid.uuid4()
    gate = await create_gate(
        session=session, org_id=org_id, work_item_id=version.id,
        work_item_type=WORKFLOW_LINE_VERSION_WORK_ITEM_TYPE,
        gate_type=WORKFLOW_CONFIG_PUBLISH_GATE_TYPE,
        member_id=member_id, role_id=role_id,
        neutral_facts={
            "version_id": str(version.id),
            "config_hash": version.config_hash,
            "requested_by_member_id": str(member_id),
            "entity_type": version.entity_type,
        },
    )
    version.review_gate_id = gate.id
    await session.flush()
    # allow_auto disposition → create_gate 가 status='auto_passed' 로 생성(approved 아님·gate.py
    # _DISPOSITION_TO_STATUS) → 즉시 publish 확정. 자동승인은 org 정책 override 결과라 self-approval
    # 가드 비대상(_auto=True). ask → 'pending' 유지(org owner/admin 승인 대기).
    if gate.status in ("approved", "auto_passed"):
        await complete_publish(session, version, gate, resolver_id=None, _auto=True)
    await session.refresh(version)
    return version, gate


async def complete_publish(
    session: AsyncSession, version: WorkflowLineDefinitionVersion, gate: Gate,
    resolver_id: uuid.UUID | None, _auto: bool = False,
) -> WorkflowLineDefinitionVersion:
    """gate approved → version published 확정 + active pointer flip(동일 트랜잭션).

    transition_gate() 직후 콜백으로 호출(내부 특수분기 금지). self-approval 은 승인 시점에 재검증.
    """
    # allow_auto disposition → 'auto_passed'(immutable), 휴먼 승인 → 'approved'. 둘 다 publish 확정.
    if gate.status not in ("approved", "auto_passed"):
        raise ValueError(f"gate {gate.id} not approved (status={gate.status})")
    if gate.gate_type != WORKFLOW_CONFIG_PUBLISH_GATE_TYPE:
        raise ValueError("gate is not a workflow_config_publish gate")
    # self-approval 재검증(휴먼 승인 경로·defense-in-depth — endpoint 가 transition_gate 전 선검증도
    # 하지만 서비스 직접 호출 대비 한 번 더). 자동승인(_auto)은 org 정책 결과라 제외.
    if not _auto:
        assert_not_self_approval(gate, resolver_id, version.id)
    if version.status == "published":
        return version  # 멱등

    now = datetime.now(timezone.utc)
    version.status = "published"
    version.published_at = now
    version.reviewed_by_member_id = resolver_id

    # active pointer flip — 같은 (org, project, entity) 의 기존 active definition 은 retire,
    # 신규 active definition 을 이 published version 으로 세운다(동일 트랜잭션).
    existing_r = await session.execute(
        select(WorkflowLineDefinition).where(
            WorkflowLineDefinition.org_id == version.org_id,
            WorkflowLineDefinition.project_id.is_(None) if version.project_id is None
            else WorkflowLineDefinition.project_id == version.project_id,
            WorkflowLineDefinition.entity_type == version.entity_type,
            WorkflowLineDefinition.is_active.is_(True),
        )
    )
    for old in existing_r.scalars().all():
        old.is_active = False
        old.retired_at = now

    definition = WorkflowLineDefinition(
        org_id=version.org_id, project_id=version.project_id, entity_type=version.entity_type,
        name=(version.config or {}).get("name") or f"{version.entity_type} line",
        version=version.version, is_active=True,
        source="project_override" if version.project_id else "org_config",
        created_by_member_id=version.created_by_member_id,
        published_at=now, config_hash=version.config_hash,
    )
    session.add(definition)
    await session.flush()
    version.line_definition_id = definition.id
    await session.flush()
    await session.refresh(version)
    return version


def assert_not_self_approval(gate: Gate, resolver_id: uuid.UUID | None, version_id: uuid.UUID) -> None:
    """요청자 == 승인자면 SelfApprovalError. transition_gate 호출 前 선검증(approve side-effect 차단)
    과 complete_publish 재검증이 공용으로 쓴다."""
    if resolver_id is None:
        return
    requested_by = (gate.neutral_facts or {}).get("requested_by_member_id")
    if requested_by and str(resolver_id) == str(requested_by):
        raise SelfApprovalError(version_id)


class PublishLintError(Exception):
    """publish lint hard-fail."""

    def __init__(self, errors: list[dict[str, str]]):
        self.errors = errors
        super().__init__(f"publish lint failed: {len(errors)} error(s)")


class SelfApprovalError(Exception):
    """요청자 == 승인자(self-approval forbidden)."""

    def __init__(self, version_id: uuid.UUID):
        self.version_id = version_id
        super().__init__("self-approval forbidden for workflow_config_publish")
