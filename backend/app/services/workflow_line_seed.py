"""E-DECISION-GATE S16: dogfood default story line seed.

뭉클랩 org 의 기본 story 라인(published ``workflow_line_definition`` + version)을 시드해 라인이
shadow 로 dogfood 관측을 시작하게 한다. S2 config 구조(lint/config_hash/모델) 재사용.

- ③ config ``rollout_mode='enforcing'``(라인 *의도*=최종 enforcing). 실제 staged rollout(shadow→
  advisory→enforcing)은 S18 runtime mode(env)가 담당하고 effective=min(runtime, config) 라
  runtime 이 stager 가 된다. "기본 shadow"는 runtime default(DECISION_GATE_LINE_MODE=shadow)로 달성.
- ② idempotent — 동일 (org, entity_type='story', source='system_default') 의 published version 이
  같은 config_hash 로 이미 있으면 재생성 0(재실행·fresh-DB 안전).
- ④ S2 ``lint_config`` 통과하는 valid config(no catch-all·approver/ fallback 정의·allowlist event).
"""
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workflow_line import WorkflowLineDefinition, WorkflowLineDefinitionVersion
from app.services.workflow_line_config import compute_config_hash, lint_config

# 뭉클랩(dogfood) org. 다른 org 시드는 명시 org_id 로.
MOONKLABS_ORG_ID = uuid.UUID("54bac162-5c0d-49fa-8e49-85977063a091")
# system seed 작성자 sentinel(거버넌스 작성자 부재·FK-free).
_SEED_AUTHOR = uuid.UUID("00000000-0000-0000-0000-000000000000")
_SOURCE = "system_default"
_ENTITY = "story"

# lean default story line(AC①): dev relay → QA observe → PO merge-gate. config 의도=enforcing
# (실제 단계는 runtime env 가 staging·min(runtime, config)).
DEFAULT_STORY_LINE_CONFIG: dict[str, Any] = {
    "rollout_mode": "enforcing",
    "steps": [
        {
            "step_key": "dev_relay",
            "from_status": "backlog", "to_status": "ready-for-dev",
            "step_type": "agent-handoff",
            "assignee_policy": {"role": "developer"},  # dev relay 대상
            "event_type": "dispatched",                # connector allow-list
        },
        {
            "step_key": "qa_observe",
            "from_status": "in-progress", "to_status": "in-review",
            "step_type": "advisory",                   # QA 단계·관측(human step 아님)
        },
        {
            "step_key": "po_merge_gate",
            "from_status": "in-review", "to_status": "done",
            "step_type": "merge-gate", "gate_type": "merge",  # H1 merge-gate wrapper
            "approval_policy": {"approver_role": "product_owner"},          # AC②: approver
            "assignee_policy": {"role": "product_owner", "fallback_role": "admin"},  # AC④: fallback
        },
    ],
}


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


async def seed_default_story_line(
    session: AsyncSession, org_id: uuid.UUID | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """org 의 기본 story 라인을 published 로 시드(idempotent). 반환: 결과 요약."""
    org_id = org_id or MOONKLABS_ORG_ID
    config = config or DEFAULT_STORY_LINE_CONFIG

    # ④ lint — invalid seed 차단(approver/fallback/allowlist/catch-all).
    errors = lint_config(config)
    if errors:
        return {"status": "lint_failed", "errors": errors}
    config_hash = compute_config_hash(config)
    now = _now()

    # 현재 org-default active definition 들(idempotency 판단 + retire 대상). active 유일성(S1 partial
    # unique)이라 보통 0~1개.
    actives = (await session.execute(
        select(WorkflowLineDefinition).where(
            WorkflowLineDefinition.org_id == org_id,
            WorkflowLineDefinition.project_id.is_(None),
            WorkflowLineDefinition.entity_type == _ENTITY,
            WorkflowLineDefinition.source == _SOURCE,
            WorkflowLineDefinition.is_active.is_(True),
        )
    )).scalars().all()
    # ② idempotent — 같은 config_hash 의 active 가 이미 있으면 skip.
    if any(d.config_hash == config_hash for d in actives):
        return {"status": "already_seeded", "config_hash": config_hash, "org_id": str(org_id)}

    # ⭐재시드 안전성(retire-then-activate): 기존 active(다른 config_hash·예: 구 shadow)를 retire
    # (is_active=False + retired_at·published version→retired) 후 새 버전을 activate. active 유일성
    # (partial unique) 위반 0·2개 active 방지.
    retired = 0
    for d in actives:
        d.is_active = False
        d.retired_at = now
        await session.execute(
            update(WorkflowLineDefinitionVersion).where(
                WorkflowLineDefinitionVersion.line_definition_id == d.id,
                WorkflowLineDefinitionVersion.status == "published",
            ).values(status="retired")
        )
        retired += 1
    if retired:
        await session.flush()

    # version uniqueness 회피 — 다음 버전 번호.
    next_v = ((await session.execute(
        select(func.coalesce(func.max(WorkflowLineDefinitionVersion.version), 0)).where(
            WorkflowLineDefinitionVersion.org_id == org_id,
            WorkflowLineDefinitionVersion.project_id.is_(None),
            WorkflowLineDefinitionVersion.entity_type == _ENTITY,
        )
    )).scalar() or 0) + 1

    defn = WorkflowLineDefinition(
        org_id=org_id, project_id=None, entity_type=_ENTITY, name="Default Story Line",
        version=next_v, is_active=True, source=_SOURCE, config_hash=config_hash, published_at=now,
        created_by_member_id=_SEED_AUTHOR,
    )
    session.add(defn)
    await session.flush()
    session.add(WorkflowLineDefinitionVersion(
        line_definition_id=defn.id, org_id=org_id, project_id=None, entity_type=_ENTITY, version=next_v,
        status="published", config=config, config_hash=config_hash, lint_status="passed",
        created_by_member_id=_SEED_AUTHOR, published_at=now,
    ))
    await session.flush()
    await session.commit()
    return {
        "status": "seeded", "config_hash": config_hash, "org_id": str(org_id),
        "definition_id": str(defn.id), "version": next_v, "retired_previous": retired,
        "rollout_mode": config.get("rollout_mode"),
    }
