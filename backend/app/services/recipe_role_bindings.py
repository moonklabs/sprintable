"""Recipe role bindings — the stage → target rules and the one upsert, shared by the recipe apply API
(`POST /events/definitions/{id}/apply`) and the desktop setup confirmation (story #4424). Moved out of the router so both
write bindings the same way (no second copy of the upsert). Neither function commits."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.recipe_role_binding import RecipeRoleBinding


def stage_target(definition, stage: str) -> str:
    """story #4090/#4101 — what a stage binds to, from `capability.target`: `channel_connection` · `generation_connector`,
    anything else (or no declaration) `agent`. Not from `capability.kind` — that one is an open value."""
    capability = (definition.stage_metadata.get(stage) or {}).get("capability")
    target = (capability or {}).get("target")
    return target if target in ("channel_connection", "generation_connector") else "agent"


async def upsert_role_binding(
    db: AsyncSession,
    *,
    org_id: uuid.UUID,
    project_id: uuid.UUID | None,
    definition_key: str,
    stage: str,
    target: str,
    value_id: uuid.UUID,
    actor_id: uuid.UUID | None,
) -> None:
    """One (org, project scope, definition, stage) row. A re-apply may change the target kind of a stage (a definition gained or
    lost a capability), so all three target columns are set every time — setting one alone would leave the old value in another
    column and break `ck_recipe_role_bindings_exactly_one_target`."""
    col_agent = value_id if target == "agent" else None
    col_channel = value_id if target == "channel_connection" else None
    col_generation = value_id if target == "generation_connector" else None
    # SQL NULL is not matched by `= NULL` — the project scope clause is built conditionally.
    project_scope_clause = (
        RecipeRoleBinding.project_id.is_(None) if project_id is None else RecipeRoleBinding.project_id == project_id
    )
    existing = (await db.execute(
        select(RecipeRoleBinding).where(
            RecipeRoleBinding.org_id == org_id,
            project_scope_clause,
            RecipeRoleBinding.event_definition_key == definition_key,
            RecipeRoleBinding.stage == stage,
        )
    )).scalar_one_or_none()
    if existing is not None:
        existing.agent_member_id = col_agent
        existing.channel_connection_id = col_channel
        existing.generation_connector_id = col_generation
    else:
        db.add(RecipeRoleBinding(
            org_id=org_id, project_id=project_id, event_definition_key=definition_key, stage=stage,
            agent_member_id=col_agent, channel_connection_id=col_channel, generation_connector_id=col_generation,
            created_by=actor_id,
        ))
