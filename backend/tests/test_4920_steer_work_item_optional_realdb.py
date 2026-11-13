"""story 4920 (the owner's report 11-13: «스토리 선택 안하면 메시지 전송조차 안되는지?») — `preset.steer.instruct`: the work item is optional.

Real Postgres. Three things are pinned:
1. the migration 0474 rewrites the platform definition row 0274 seeded in place (required loses work_item_type / work_item_id; the card's «대상» line is optional) — and a downgrade puts 0274's values back;
2. an instruction WITHOUT a work item publishes and reaches the target alone;
3. an instruction WITH a work item reaches exactly who it did before (the target + the work item's stakeholders) — no regression.
"""
from __future__ import annotations

import importlib.util
import os
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import select

from tests.test_2633_event_publish import (
    _REAL_DB_URL,
    _auth,
    _fake_request,
    _realdb_session,
    _seed_agent,
    _seed_org_project,
    _seed_story,
)

pytestmark = pytest.mark.destructive_schema

_VERSIONS = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """the same standard defence as test_2935 (a publish writes a message whose background task uses the process-wide engine)"""
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _load(filename: str, name: str):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_VERSIONS, filename))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _m0274():
    return _load("0274_event_definitions_preset_steer_instruct.py", "_m0274_4920")


def _m0474():
    return _load("0474_steer_instruct_work_item_optional.py", "_m0474_4920")


async def _seed_0274_definition(session):
    """the row as 0274 seeded it (and as every database that is not yet at 0474 holds it)"""
    from app.models.event_definition import EventDefinition

    m = _m0274()
    session.add(EventDefinition(
        id=uuid.uuid4(), key=m._KEY, org_id=None,
        payload_schema=m._PAYLOAD_SCHEMA, routing=m._ROUTING, block_template=m._BLOCK_TEMPLATE,
    ))
    await session.commit()


async def _run_migration(session, which: str):
    """run the REAL upgrade() / downgrade() of 0474 against this database (alembic's own operations context on the session's connection)"""
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    mod = _m0474()
    conn = await session.connection()

    def _go(sync_conn):
        ctx = MigrationContext.configure(sync_conn)
        with Operations.context(ctx):
            getattr(mod, which)()

    await conn.run_sync(_go)
    await session.commit()


async def _definition_row(session):
    from app.models.event_definition import EventDefinition

    session.expire_all()
    return (await session.execute(
        select(EventDefinition).where(EventDefinition.key == "preset.steer.instruct", EventDefinition.org_id.is_(None))
    )).scalar_one()


def _target_line(template: dict) -> dict:
    fields = next(b for b in template["blocks"] if b["type"] == "fields")["fields"]
    return next(f for f in fields if f["value"] == "{{payload.work_item_id}}")


async def _publish(s, *, org_id, publisher_id, payload):
    from app.routers.events import EventPublishRequest, publish_registry_event

    body = EventPublishRequest(definition_key="preset.steer.instruct", payload=payload)
    return await publish_registry_event(
        body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
    )


# ─── 1. the migration rewrites the seeded row ─────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_upgrade_makes_the_work_item_optional_and_downgrade_restores_0274():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            await _seed_0274_definition(s)
            before = await _definition_row(s)
            assert {"work_item_type", "work_item_id"} <= set(before.payload_schema["required"]), "the seeded row requires the work item (the defect)"
            assert "optional" not in _target_line(before.block_template)

            await _run_migration(s, "upgrade")
            after = await _definition_row(s)
            assert sorted(after.payload_schema["required"]) == ["instruction", "target_member_id"]
            assert {"work_item_type", "work_item_id"} <= set(after.payload_schema["properties"]), "still allowed (and still read by the card)"
            assert _target_line(after.block_template).get("optional") is True
            assert after.routing == before.routing, "routing is untouched"

            await _run_migration(s, "downgrade")
            back = await _definition_row(s)
            assert back.payload_schema == before.payload_schema and back.block_template == before.block_template
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_upgrade_touches_only_the_platform_row_of_the_key():
    """an org's own definition (`org_id` set — the schema keeps the `preset.` namespace to the platform rows, so it carries its own key) is that org's: left exactly as it is"""
    from app.models.event_definition import EventDefinition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org_project(s)
            await _seed_0274_definition(s)
            m = _m0274()
            own_id = uuid.uuid4()
            s.add(EventDefinition(
                id=own_id, key="org.acme.steer_instruct", org_id=org_id,
                payload_schema=m._PAYLOAD_SCHEMA, routing=m._ROUTING, block_template=m._BLOCK_TEMPLATE,
            ))
            await s.commit()
            await _run_migration(s, "upgrade")
            s.expire_all()
            own = (await s.execute(select(EventDefinition).where(EventDefinition.id == own_id))).scalar_one()
            assert own.payload_schema == m._PAYLOAD_SCHEMA and own.block_template == m._BLOCK_TEMPLATE, "the org's own definition is not rewritten"
    finally:
        await engine.dispose()


# ─── 2 + 3. publishing, on a database at 0474 ─────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_before_the_migration_an_instruction_without_a_work_item_is_refused_400():
    """the defect, at the server: on the 0274 row the publish is refused (reverting the migration turns the next test red for the same reason)"""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_0274_definition(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            target_id = await _seed_agent(s, org_id, project_id, name="target")
            with pytest.raises(HTTPException) as ei:
                await _publish(s, org_id=org_id, publisher_id=publisher_id, payload={"target_member_id": str(target_id), "instruction": "이제 A로 가자"})
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_instruction_without_a_work_item_publishes_and_reaches_the_target_alone():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_0274_definition(s)
            await _run_migration(s, "upgrade")
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            target_id = await _seed_agent(s, org_id, project_id, name="target")
            resp = await _publish(s, org_id=org_id, publisher_id=publisher_id, payload={"target_member_id": str(target_id), "instruction": "이제 A로 가자"})
            assert resp["escalation_member_ids"] == [str(target_id)]
            assert resp["broadcast_member_ids"] == [], "no work item → no stakeholders: the target alone"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_instruction_with_a_work_item_reaches_the_same_people_as_before():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_0274_definition(s)
            await _run_migration(s, "upgrade")
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            target_id = await _seed_agent(s, org_id, project_id, name="target")
            stakeholder_id = await _seed_agent(s, org_id, project_id, name="stakeholder")
            story_id = await _seed_story(s, org_id, project_id, human_owner_member_id=stakeholder_id)
            resp = await _publish(s, org_id=org_id, publisher_id=publisher_id, payload={
                "work_item_type": "story", "work_item_id": str(story_id),
                "target_member_id": str(target_id), "instruction": "이 스토리 우선순위를 올려주세요",
            })
            assert resp["escalation_member_ids"] == [str(target_id)]
            assert str(stakeholder_id) in resp["broadcast_member_ids"]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_the_instruction_text_and_the_target_are_still_required():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_0274_definition(s)
            await _run_migration(s, "upgrade")
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            target_id = await _seed_agent(s, org_id, project_id, name="target")
            with pytest.raises(HTTPException) as no_text:
                await _publish(s, org_id=org_id, publisher_id=publisher_id, payload={"target_member_id": str(target_id)})
            assert no_text.value.status_code == 400
            with pytest.raises(HTTPException) as no_target:
                await _publish(s, org_id=org_id, publisher_id=publisher_id, payload={"instruction": "누구에게?"})
            assert no_target.value.status_code == 400
    finally:
        await engine.dispose()
