"""story #4846 (AC12) — an agent writes in a room of a project only while it has the project; the notice of a recipe it is BOUND to is the one thing
that passes without the project, on the ground of the binding (a setting the user gave the agent):

- an organization-wide binding (no project) → the stage notice goes out, an ordinary message of the same agent into the same room is still 403;
- a binding of the project → the notice goes out while the agent holds the project, and stops when the project is revoked;
- no binding (or a binding of another recipe, or of another project) → the notice is 403 like any message;
- the mark that carries the check (`RecipeBoundAuth`) is built in one place, and a plain context with the very same claims — or a bound mark for another
  project's room — does not pass;
- binding an agent to a PROJECT needs the agent to have that project (409 with a code); an organization-wide binding is unchanged.

Real PG (migrated schema), the recipe-publish world of test_4255."""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException

from tests.test_4090_ac2_recipe_auto_publish_realdb import (
    _auth,
    _fake_request,
    _realdb_session,
    _seed_agent,
    _seed_default_role,
    _seed_org_with_owner,
    _seed_story,
    _seed_system_publisher_teammember_shim,
)
from tests.test_4255_last_server_stage_recipients_realdb import _KEY, _SEED, _SEED_MODULE  # noqa: F401

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


async def _realdb_session_sync():
    engine, Session = await _realdb_session()
    return Session


async def _world(Session, *, binding: str, grant: bool):
    """an agent placed in a project of an organization, with `binding` in {"none", "org", "project", "other_recipe", "other_project"} and its project
    grant present or not (the grant is what a real placement has; `grant=False` is the agent whose project was revoked)"""
    from sqlalchemy import delete

    from app.models.event_definition import EventDefinition
    from app.models.project import Project
    from app.models.project_access import ProjectAccess
    from app.models.recipe_role_binding import RecipeRoleBinding

    async with Session() as s:
        org_id, project_id, owner_member_id, owner_user_id = await _seed_org_with_owner(s, slug=f"l4846r-{uuid.uuid4().hex[:6]}")
        await _seed_default_role(s, org_id)
        await _seed_system_publisher_teammember_shim(s, org_id, project_id)
        agent_id = await _seed_agent(s, org_id, project_id, name="Creator")
        story_id = await _seed_story(s, org_id, project_id, title="SNS 게시 회차")
        other_project = uuid.uuid4()
        s.add(Project(id=other_project, org_id=org_id, name="Other"))
        if (await s.execute(EventDefinition.__table__.select().where(EventDefinition.key == _KEY))).first() is None:
            s.add(EventDefinition(
                id=uuid.uuid4(), key=_KEY, org_id=None, name=_SEED["name"], description=_SEED["description"],
                payload_schema=_SEED["payload_schema"], routing=_SEED_MODULE._ROUTING,
                block_template=_SEED["block_template"], stage_metadata=_SEED["stage_metadata"],
                role_actor_kinds=_SEED["role_actor_kinds"], enabled=True, version=1,
            ))
        await s.flush()
        row = {"id": uuid.uuid4(), "org_id": org_id, "stage": "draft", "agent_member_id": agent_id, "event_definition_key": _KEY, "project_id": None}
        if binding == "project":
            row["project_id"] = project_id
        elif binding == "other_project":
            row["project_id"] = other_project
        elif binding == "other_recipe":
            row["event_definition_key"] = "org.moonklabs.some_other_recipe"
        if binding != "none":
            s.add(RecipeRoleBinding(**row))
        if not grant:
            await s.execute(delete(ProjectAccess).where(ProjectAccess.member_id == agent_id))
        await s.commit()
    return {
        "org_id": org_id, "project_id": project_id, "agent_id": agent_id, "story_id": story_id, "owner_user_id": owner_user_id,
        "owner_member_id": owner_member_id, "other_project": other_project,
    }


async def _publish(Session, w) -> None:
    from app.routers.events import EventPublishRequest, publish_registry_event

    async with Session() as s:
        await publish_registry_event(
            EventPublishRequest(definition_key=_KEY, payload={"stage": "draft", "work_item_type": "story", "work_item_id": str(w["story_id"])}),
            BackgroundTasks(), _fake_request(), db=s, auth=_auth(w["agent_id"], w["org_id"]), org_id=w["org_id"],
        )
        await s.commit()


async def _room_of(Session, w) -> uuid.UUID:
    from sqlalchemy import select

    from app.models.conversation import Conversation

    async with Session() as s:
        return (await s.execute(select(Conversation.id).where(Conversation.project_id == w["project_id"]).limit(1))).scalar_one()


async def _post(Session, w, conversation_id, auth):
    from app.routers.conversations import SendMessageRequest, send_message_core

    async with Session() as s:
        out = await send_message_core(conversation_id, SendMessageRequest(content="hello"), BackgroundTasks(), db=s, auth=auth, org_id=w["org_id"])
        await s.commit()
        return out


async def test_an_organization_wide_binding_lets_the_notice_out_but_not_an_ordinary_message():
    Session = await _realdb_session_sync()
    w = await _world(Session, binding="org", grant=False)
    await _publish(Session, w)                                                   # the notice goes out
    room = await _room_of(Session, w)
    with pytest.raises(HTTPException) as e:                                      # the same agent's ordinary message into the same room does not
        await _post(Session, w, room, _auth(w["agent_id"], w["org_id"]))
    assert e.value.status_code == 403


async def test_a_project_binding_carries_the_notice_while_the_agent_has_the_project_and_stops_when_revoked(caplog):
    Session = await _realdb_session_sync()
    w = await _world(Session, binding="project", grant=True)
    await _publish(Session, w)
    w2 = await _world(Session, binding="project", grant=False)                   # the project revoked: the binding's notices stop with it
    with caplog.at_level("WARNING", logger="app.services.recipe_role_bindings"):
        with pytest.raises(HTTPException) as e:
            await _publish(Session, w2)
    assert e.value.status_code == 403 and e.value.detail == "Not a participant"        # the room's term, not the stage rule
    # the refusal leaves ONE line with the reason, the recipe, the project and the agent (no content) — counted in the logs after a deploy to clean up
    lines = [r.getMessage() for r in caplog.records if "RECIPE_BINDING_LACKS_GRANT" in r.getMessage()]
    assert len(lines) == 1 and str(w2["agent_id"]) in lines[0] and str(w2["project_id"]) in lines[0] and _KEY in lines[0], lines


async def test_an_agent_that_is_not_the_stage_assignee_is_refused_by_the_stage_rule_before_the_room_is_asked():
    """no binding / a binding of another recipe or project: the stage rule (only the assignee publishes its stage) refuses first — a different 403"""
    Session = await _realdb_session_sync()
    for binding in ("none", "other_recipe", "other_project"):
        w = await _world(Session, binding=binding, grant=False)
        with pytest.raises(HTTPException) as e:
            await _publish(Session, w)
        assert e.value.status_code == 403 and e.value.detail["code"] == "NOT_STAGE_ASSIGNEE", binding


async def test_which_bindings_count_for_a_notice_about_a_work_item_of_a_project():
    """the truth table of the check itself: org-wide counts anywhere; a project binding counts for that project while the agent holds it; a binding of
    another recipe, of another project, or none does not"""
    from sqlalchemy import delete

    from app.models.project_access import ProjectAccess
    from app.models.recipe_role_binding import RecipeRoleBinding
    from app.services.recipe_role_bindings import agent_bound_to_recipe

    Session = await _realdb_session_sync()
    expected = {
        ("org", True): True, ("org", False): True,
        ("project", True): True, ("project", False): False,
        ("other_project", True): False, ("other_project", False): False,
        ("other_recipe", True): False, ("other_recipe", False): False,
        ("none", True): False, ("none", False): False,
    }
    w = await _world(Session, binding="none", grant=True)             # ONE world; each case below rewrites its binding and grant
    other_key = "org.moonklabs.some_other_recipe"
    for (binding, grant), want in expected.items():
        async with Session() as s:
            await s.execute(delete(RecipeRoleBinding).where(RecipeRoleBinding.org_id == w["org_id"]))
            scope = {"org": None, "project": w["project_id"], "other_project": w["other_project"], "other_recipe": w["project_id"], "none": None}[binding]
            if binding != "none":
                s.add(RecipeRoleBinding(
                    id=uuid.uuid4(), org_id=w["org_id"], project_id=scope, stage="draft", agent_member_id=w["agent_id"],
                    event_definition_key=other_key if binding == "other_recipe" else _KEY,
                ))
            await s.execute(delete(ProjectAccess).where(ProjectAccess.member_id == w["agent_id"]))
            if grant:
                s.add(ProjectAccess(project_id=w["project_id"], member_id=w["agent_id"], org_member_id=None, permission="granted"))
            await s.commit()
        async with Session() as s:
            got = await agent_bound_to_recipe(s, org_id=w["org_id"], agent_member_id=w["agent_id"], definition_key=_KEY, project_id=w["project_id"])
        assert got is want, (binding, grant, got)


async def test_a_caller_who_names_the_room_gets_the_ordinary_rule_not_the_binding():
    """the lens find: an organization-wide binding of an agent whose project was revoked, a work item of that project, and `conversation_id` = a group room of
    the project the agent is still a participant of → the notice went into that room (201). The mark is built only for the room the publish chooses itself;
    a named room takes the ordinary rule: the agent needs the project there (403), and with the project it goes in."""
    from sqlalchemy import select

    from app.models.conversation import Conversation, ConversationParticipant
    from app.models.project_access import ProjectAccess
    from app.routers.events import EventPublishRequest, publish_registry_event

    Session = await _realdb_session_sync()
    w = await _world(Session, binding="org", grant=True)
    async with Session() as s:                                                   # a group room of the project the agent is a participant of
        group = Conversation(id=uuid.uuid4(), org_id=w["org_id"], project_id=w["project_id"], type="group", created_by=w["owner_member_id"])
        s.add(group)
        await s.flush()
        for member in (w["owner_member_id"], w["agent_id"]):
            s.add(ConversationParticipant(conversation_id=group.id, member_id=member))
        stories = [await _seed_story(s, w["org_id"], w["project_id"], title=f"S{i}") for i in range(3)]
        await s.commit()

    async def publish_into(story_id, conversation_id):
        async with Session() as s:
            await publish_registry_event(
                EventPublishRequest(
                    definition_key=_KEY, conversation_id=conversation_id,
                    payload={"stage": "draft", "work_item_type": "story", "work_item_id": str(story_id)},
                ),
                BackgroundTasks(), _fake_request(), db=s, auth=_auth(w["agent_id"], w["org_id"]), org_id=w["org_id"],
            )
            await s.commit()

    await publish_into(stories[0], group.id)                                     # with the project: the named room goes in as it always did
    async with Session() as s:                                                   # the project is revoked
        from sqlalchemy import delete

        await s.execute(delete(ProjectAccess).where(ProjectAccess.member_id == w["agent_id"]))
        await s.commit()
    with pytest.raises(HTTPException) as e:                                      # a named room takes the ordinary rule, the binding does not open it
        await publish_into(stories[1], group.id)
    assert e.value.status_code == 403 and e.value.detail == "Not a participant"
    await publish_into(stories[2], None)                                         # no room named: the publish's own room still takes the binding's notice


async def test_a_plain_context_with_the_same_claims_or_a_mark_for_another_project_does_not_pass():
    from app.dependencies.auth import AuthContext, RecipeBoundAuth

    Session = await _realdb_session_sync()
    w = await _world(Session, binding="org", grant=False)
    await _publish(Session, w)                                                   # creates the room
    room = await _room_of(Session, w)
    plain = _auth(w["agent_id"], w["org_id"])
    forged = AuthContext(user_id=plain.user_id, email=None, claims=dict(plain.claims, recipe_bound=True, bound_project_id=str(w["project_id"])), org_id=plain.org_id)
    for auth in (plain, forged):
        with pytest.raises(HTTPException) as e:
            await _post(Session, w, room, auth)
        assert e.value.status_code == 403
    for_other = RecipeBoundAuth(user_id=plain.user_id, email=None, claims=plain.claims, org_id=plain.org_id, bound_project_id=w["other_project"])
    with pytest.raises(HTTPException) as e:                                      # the mark is for ONE project's room
        await _post(Session, w, room, for_other)
    assert e.value.status_code == 403
    ok = RecipeBoundAuth(user_id=plain.user_id, email=None, claims=plain.claims, org_id=plain.org_id, bound_project_id=w["project_id"])
    await _post(Session, w, room, ok)                                            # control: the mark for this project's room passes


async def test_the_only_place_that_builds_the_mark_is_the_recipe_publish():
    import pathlib
    import re

    root = pathlib.Path(__file__).resolve().parents[1] / "app"
    users = sorted(str(p.relative_to(root)) for p in root.rglob("*.py") if re.search(r"(?<!class )\bRecipeBoundAuth\(", p.read_text(encoding="utf-8")))
    assert users == ["routers/events.py"], users


async def test_binding_an_agent_to_a_project_needs_the_agent_to_have_the_project():
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    Session = await _realdb_session_sync()
    w = await _world(Session, binding="none", grant=False)
    async with Session() as s:
        from sqlalchemy import select

        from app.models.event_definition import EventDefinition

        definition_id = (await s.execute(select(EventDefinition.id).where(EventDefinition.key == _KEY))).scalar_one()
    owner = _auth(w["owner_user_id"], w["org_id"])
    owner.claims.clear()                                                         # a person's context (no api key)
    owner.claims["app_metadata"] = {}

    async def apply(project_id):
        async with Session() as s:
            out = await apply_recipe_role_bindings(
                definition_id, ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"draft": str(w["agent_id"])}),
                db=s, auth=owner, org_id=w["org_id"],
            )
            await s.commit()
            return out

    with pytest.raises(HTTPException) as e:                                      # a project binding for an agent without the project: told now
        await apply(w["project_id"])
    assert e.value.status_code == 409 and e.value.detail["code"] == "AGENT_LACKS_PROJECT"
    await apply(None)                                                            # the organization-wide binding is unchanged


async def test_the_mark_is_only_for_a_recipe_and_the_apply_409_only_for_an_agent():
    """self-QA round: (1) a binding row of an event key whose definition is NOT a recipe (no `recipe_role_binding` routing) must not let that event past the
    room's agent-project term; (2) a PERSON mapped to a stage is not asked for the project — only an agent is."""
    from app.models.event_definition import EventDefinition
    from app.models.recipe_role_binding import RecipeRoleBinding
    from app.models.team import TeamMember
    from app.routers.events import ApplyRecipeRoleBindingsRequest, EventPublishRequest, apply_recipe_role_bindings, publish_registry_event

    Session = await _realdb_session_sync()
    w = await _world(Session, binding="none", grant=False)
    other_key = f"org.moonklabs.plain_{uuid.uuid4().hex[:6]}"
    human_outside = uuid.uuid4()
    async with Session() as s:
        s.add(EventDefinition(
            id=uuid.uuid4(), key=other_key, org_id=w["org_id"], name="plain", description="not a recipe",
            payload_schema={"type": "object", "required": ["work_item_type", "work_item_id"],
                            "properties": {"work_item_type": {"type": "string"}, "work_item_id": {"type": "string"}}},
            routing={"escalation": {"kind": "server_derived", "target": "none"}, "broadcast": {"kind": "server_derived", "target": "none"}},
            block_template={}, stage_metadata={}, enabled=True, version=1,
        ))
        s.add(RecipeRoleBinding(id=uuid.uuid4(), org_id=w["org_id"], project_id=None, stage="x", agent_member_id=w["agent_id"], event_definition_key=other_key))
        s.add(TeamMember(id=human_outside, org_id=w["org_id"], project_id=w["other_project"], type="human", name="outside", is_active=True))
        await s.commit()

    async with Session() as s:                                                   # (1) the plain event of an agent with a binding row but no project → refused
        with pytest.raises(HTTPException) as e:
            await publish_registry_event(
                EventPublishRequest(definition_key=other_key, payload={"work_item_type": "story", "work_item_id": str(w["story_id"])}),
                BackgroundTasks(), _fake_request(), db=s, auth=_auth(w["agent_id"], w["org_id"]), org_id=w["org_id"],
            )
        assert e.value.status_code == 403 and e.value.detail == "Not a participant"

    async with Session() as s:                                                   # (2) a person without the project, mapped to a stage → not a 409
        from sqlalchemy import select

        definition_id = (await s.execute(select(EventDefinition.id).where(EventDefinition.key == _KEY))).scalar_one()
        owner = _auth(w["owner_user_id"], w["org_id"])
        owner.claims.clear()
        owner.claims["app_metadata"] = {}
        out = await apply_recipe_role_bindings(
            definition_id, ApplyRecipeRoleBindingsRequest(project_id=w["project_id"], role_mapping={"draft": str(human_outside)}),
            db=s, auth=owner, org_id=w["org_id"],
        )
        await s.commit()
        assert out is not None


async def test_the_truth_table_of_the_one_predicate_that_lets_a_notice_carry_the_mark():
    """the mark stood too wide three times (a bypass of the room term; a room the caller named; an event that is not a recipe's). Its conditions are ONE predicate
    (`recipe_notice_stands_on_binding`) and this is its truth table: definition kind (recipe / not) × binding (organization-wide / project + the project held /
    project + revoked / none) × room (the publish's own / named by the caller) — the mark stands ONLY for a recipe, bound organization-wide or by the project the agent
    still holds, in the publish's own room; then each other term (sender an agent · a plain call · a known project) turned off on the best cell. A mutant deletes each term."""
    from sqlalchemy import delete, select

    from app.models.event_definition import EventDefinition
    from app.models.project_access import ProjectAccess
    from app.models.recipe_role_binding import RecipeRoleBinding
    from app.services.recipe_role_bindings import recipe_notice_stands_on_binding

    Session = await _realdb_session_sync()
    w = await _world(Session, binding="none", grant=True)
    plain_key = f"org.moonklabs.plain_{uuid.uuid4().hex[:6]}"
    async with Session() as s:
        s.add(EventDefinition(
            id=uuid.uuid4(), key=plain_key, org_id=w["org_id"], name="plain", description="not a recipe",
            payload_schema={"type": "object"},
            routing={"escalation": {"kind": "server_derived", "target": "none"}, "broadcast": {"kind": "server_derived", "target": "none"}},
            block_template={}, stage_metadata={}, enabled=True, version=1,
        ))
        await s.commit()
    async with Session() as s:
        definitions = {
            "recipe": (await s.execute(select(EventDefinition).where(EventDefinition.key == _KEY))).scalars().first(),
            "plain": (await s.execute(select(EventDefinition).where(EventDefinition.key == plain_key))).scalars().first(),
        }

    async def arrange(kind: str, binding: str) -> None:
        async with Session() as s:
            await s.execute(delete(RecipeRoleBinding).where(RecipeRoleBinding.org_id == w["org_id"]))
            if binding != "none":
                s.add(RecipeRoleBinding(
                    id=uuid.uuid4(), org_id=w["org_id"], project_id=None if binding == "org" else w["project_id"], stage="draft",
                    agent_member_id=w["agent_id"], event_definition_key=definitions[kind].key,
                ))
            await s.execute(delete(ProjectAccess).where(ProjectAccess.member_id == w["agent_id"]))
            if binding != "project_revoked":
                s.add(ProjectAccess(project_id=w["project_id"], member_id=w["agent_id"], org_member_id=None, permission="granted"))
            await s.commit()

    async def stands(kind, *, named=False, sender_type="agent", plain_call=True, project=True) -> bool:
        async with Session() as s:
            return await recipe_notice_stands_on_binding(
                s, org_id=w["org_id"], sender_type=sender_type, plain_call=plain_call, definition=definitions[kind],
                project_id=w["project_id"] if project else None, named_room=named, agent_member_id=w["agent_id"],
            )

    for kind in ("recipe", "plain"):
        for binding in ("org", "project", "project_revoked", "none"):
            await arrange(kind, binding)
            for named in (False, True):
                want = kind == "recipe" and binding in ("org", "project") and not named
                assert await stands(kind, named=named) is want, (kind, binding, "named" if named else "own room")

    await arrange("recipe", "org")                                                  # the best cell, then each remaining term off
    assert await stands("recipe") is True
    assert await stands("recipe", sender_type="human") is False
    assert await stands("recipe", plain_call=False) is False
    assert await stands("recipe", project=False) is False
