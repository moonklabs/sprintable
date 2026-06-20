"""E-DECISION-GATE S16: dogfood default story line seed.

뭉클랩 org 의 기본 story 라인(published ``workflow_line_definition`` + version)을 시드해 라인이
shadow 로 dogfood 관측을 시작하게 한다. S2 config 구조(lint/config_hash/모델) 재사용.

- ③ 기본 ``rollout_mode='shadow'``(enforcing 아님·S18 runtime mode 와 정합·라이브 무영향).
- ② idempotent — 동일 (org, entity_type='story', source='system_default') 의 published version 이
  같은 config_hash 로 이미 있으면 재생성 0(재실행·fresh-DB 안전).
- ④ S2 ``lint_config`` 통과하는 valid config(no catch-all·approver/ fallback 정의·allowlist event).
"""
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workflow_line import WorkflowLineDefinition, WorkflowLineDefinitionVersion
from app.services.workflow_line_config import compute_config_hash, lint_config

# 뭉클랩(dogfood) org. 다른 org 시드는 명시 org_id 로.
MOONKLABS_ORG_ID = uuid.UUID("54bac162-5c0d-49fa-8e49-85977063a091")
# system seed 작성자 sentinel(거버넌스 작성자 부재·FK-free).
_SEED_AUTHOR = uuid.UUID("00000000-0000-0000-0000-000000000000")
_SOURCE = "system_default"
_ENTITY = "story"

# lean default story line(AC①): dev relay → QA observe → PO merge-gate. 기본 shadow.
DEFAULT_STORY_LINE_CONFIG: dict[str, Any] = {
    "rollout_mode": "shadow",
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

    # ② idempotent — 같은 hash 의 published version 이 이미 있으면 skip.
    existing = (await session.execute(
        select(WorkflowLineDefinitionVersion.id).where(
            WorkflowLineDefinitionVersion.org_id == org_id,
            WorkflowLineDefinitionVersion.project_id.is_(None),
            WorkflowLineDefinitionVersion.entity_type == _ENTITY,
            WorkflowLineDefinitionVersion.status == "published",
            WorkflowLineDefinitionVersion.config_hash == config_hash,
        ).limit(1)
    )).scalar_one_or_none()
    if existing is not None:
        return {"status": "already_seeded", "config_hash": config_hash, "org_id": str(org_id)}

    now = _now()
    defn = WorkflowLineDefinition(
        org_id=org_id, project_id=None, entity_type=_ENTITY, name="Default Story Line",
        version=1, is_active=True, source=_SOURCE, config_hash=config_hash, published_at=now,
        created_by_member_id=_SEED_AUTHOR,
    )
    session.add(defn)
    await session.flush()
    session.add(WorkflowLineDefinitionVersion(
        line_definition_id=defn.id, org_id=org_id, project_id=None, entity_type=_ENTITY, version=1,
        status="published", config=config, config_hash=config_hash, lint_status="passed",
        created_by_member_id=_SEED_AUTHOR, published_at=now,
    ))
    await session.flush()
    await session.commit()
    return {
        "status": "seeded", "config_hash": config_hash, "org_id": str(org_id),
        "definition_id": str(defn.id), "rollout_mode": config.get("rollout_mode"),
    }
