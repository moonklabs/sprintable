"""Recipe role bindings — the stage → target rules and the one upsert, shared by the recipe apply API
(`POST /events/definitions/{id}/apply`) and the desktop setup confirmation (story #4424). Moved out of the router so both
write bindings the same way (no second copy of the upsert). Neither function commits."""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.recipe_role_binding import RecipeRoleBinding

logger = logging.getLogger(__name__)


def stage_target(definition, stage: str) -> str:
    """story #4090/#4101 — what a stage binds to, from `capability.target`: `channel_connection` · `generation_connector`,
    anything else (or no declaration) `agent`. Not from `capability.kind` — that one is an open value."""
    capability = (definition.stage_metadata.get(stage) or {}).get("capability")
    target = (capability or {}).get("target")
    return target if target in ("channel_connection", "generation_connector") else "agent"


async def agent_bound_to_recipe(
    db: AsyncSession, *, org_id: uuid.UUID, agent_member_id: uuid.UUID, definition_key: str, project_id: uuid.UUID | None,
) -> bool:
    """story #4846 (AC12) — is this agent bound to this recipe, for a notice about a work item of `project_id`? An organization-wide binding (no project) is
    the user saying «this agent does this recipe's work across the organization» and counts for any project; a binding of `project_id` counts only while the
    agent still holds that project (revoking the project stops the notices of that binding)."""
    from app.services.project_auth import has_project_access

    scopes = set((await db.execute(
        select(RecipeRoleBinding.project_id).where(
            RecipeRoleBinding.org_id == org_id, RecipeRoleBinding.agent_member_id == agent_member_id,
            RecipeRoleBinding.event_definition_key == definition_key,
            or_(RecipeRoleBinding.project_id.is_(None), RecipeRoleBinding.project_id == project_id),
        )
    )).scalars().all())
    if None in scopes:
        return True
    if project_id is None or project_id not in scopes:
        return False
    if await has_project_access(db, agent_member_id, project_id, org_id):
        return True
    # a binding of the project whose agent no longer has it: its notices stop here — one line with the reason (no content), so the number of such bindings
    # can be counted in the logs after a deploy and the bindings cleaned up (give the grant, or bind organization-wide)
    logger.warning(
        "recipe notice refused reason=RECIPE_BINDING_LACKS_GRANT definition_key=%s project_id=%s agent_member_id=%s org_id=%s",
        definition_key, project_id, agent_member_id, org_id,
    )
    return False


def is_recipe_definition(definition) -> bool:
    """a RECIPE is an event definition whose broadcast is routed by the recipe role bindings"""
    return (((getattr(definition, "routing", None) or {}).get("broadcast")) or {}).get("kind") == "recipe_role_binding"


async def recipe_notice_stands_on_binding(
    db: AsyncSession, *, org_id: uuid.UUID, sender_type: str, plain_call: bool, definition, project_id: uuid.UUID | None,
    named_room: bool, agent_member_id: uuid.UUID,
) -> bool:
    """story #4846 (AC12) — THE ONE PREDICATE for «this publish may carry the recipe-bound mark». Every term must hold, and the truth table of
    tests/test_4846_recipe_bound_notice_realdb.py pins each (a mutant deletes each term):
      · the sender is an AGENT, and the call is a plain one (not the system publisher and not a server-issued context — those have their own ground);
      · the event is about a work item of a known project;
      · the caller did NOT name the room (a named room is the caller's choice and takes the ordinary rule);
      · the event is a RECIPE's (its broadcast is routed by the role bindings), not any event of a key that has a binding row;
      · this agent is bound to this recipe for that project (`agent_bound_to_recipe`)."""
    return bool(
        sender_type == "agent"
        and plain_call
        and project_id is not None
        and not named_room
        and is_recipe_definition(definition)
        and await agent_bound_to_recipe(
            db, org_id=org_id, agent_member_id=agent_member_id, definition_key=definition.key, project_id=project_id,
        )
    )


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
