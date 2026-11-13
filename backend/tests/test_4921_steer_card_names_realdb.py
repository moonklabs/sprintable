"""story 4921 — the direction instruction's card says WHO and WHAT in words (not uuids): the publish route resolves `target_member_id` / `issued_by_member_id` into `refs.target` / `refs.issued_by`,
and migration 0475 rewrites the card template to name labels and translated words.

Real Postgres. Pinned: (1) 0475's real upgrade()/downgrade() against the row 0274 seeded (and 0474 changed) — the template placeholders, downgrade = what 0474 left, no other row touched; (2) a published instruction
carries `refs.target` = the member's NAME and `refs.work_item` = the title token when a work item is given (and none when not); (3) an issuer that cannot be named is `{found: False}` (never an invented name).
"""
from __future__ import annotations

import importlib.util
import os
import uuid

import pytest
from fastapi import BackgroundTasks
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
from tests.test_4920_steer_work_item_optional_realdb import _seed_0274_definition

pytestmark = pytest.mark.destructive_schema

_VERSIONS = os.path.join(os.path.dirname(__file__), "..", "alembic", "versions")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """the standard defence of the publish tests (a publish writes a message whose background task uses the process-wide engine)"""
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _load(filename: str, name: str):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_VERSIONS, filename))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _m0474():
    return _load("0474_steer_instruct_work_item_optional.py", "_m0474_4921")


def _m0475():
    return _load("0475_steer_instruct_card_names.py", "_m0475_4921")


async def _run(session, mod, which: str):
    """run the REAL upgrade() / downgrade() of a migration against this database"""
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext

    conn = await session.connection()

    def _go(sync_conn):
        ctx = MigrationContext.configure(sync_conn)
        with Operations.context(ctx):
            getattr(mod, which)()

    await conn.run_sync(_go)
    await session.commit()


async def _row(session):
    from app.models.event_definition import EventDefinition

    session.expire_all()
    return (await session.execute(
        select(EventDefinition).where(EventDefinition.key == "preset.steer.instruct", EventDefinition.org_id.is_(None))
    )).scalar_one()


async def _at_0475(session):
    """the row as a database at 0475 holds it: 0274's seed, then 0474, then 0475"""
    await _seed_0274_definition(session)
    await _run(session, _m0474(), "upgrade")
    await _run(session, _m0475(), "upgrade")


async def _publish(s, *, org_id, publisher_id, payload):
    from app.routers.events import EventPublishRequest, publish_registry_event

    resp = await publish_registry_event(
        EventPublishRequest(definition_key="preset.steer.instruct", payload=payload),
        BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
    )
    await s.commit()
    from app.models.conversation import ConversationMessage

    msg = (await s.execute(select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(resp["message_id"])))).scalar_one()
    return resp, (msg.msg_metadata or {}).get("event", {})


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_0475_upgrade_names_the_card_in_labels_and_downgrade_restores_what_0474_left():
    from app.models.event_definition import EventDefinition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            await _seed_0274_definition(s)
            await _run(s, _m0474(), "upgrade")
            at_0474 = await _row(s)
            assert at_0474.block_template == _m0474()._BLOCK_TEMPLATE_AFTER
            other_id = uuid.uuid4()
            other_template = {"blocks": [{"type": "header", "text": "다른 정의"}]}
            s.add(EventDefinition(id=other_id, key="preset.other.sample", org_id=None, payload_schema=at_0474.payload_schema, routing=at_0474.routing, block_template=other_template))
            await s.commit()

            await _run(s, _m0475(), "upgrade")
            row = await _row(s)
            tpl = row.block_template
            assert tpl["blocks"][0] == {"type": "header", "text": "{{t.steerHeader}}"}
            fields = next(b for b in tpl["blocks"] if b["type"] == "fields")["fields"]
            assert fields == [
                {"label": "{{t.targetLabel}}", "value": "{{label.work_item_target}}", "optional": True},
                {"label": "{{t.steerTargetLabel}}", "value": "{{label.target_name}}", "optional": True},
            ]
            assert "payload.target_member_id" not in str(tpl) and "payload.work_item_id" not in str(tpl), "no raw id placeholder is left on the card"
            assert row.payload_schema == at_0474.payload_schema and row.routing == at_0474.routing, "only the template changes"
            other = (await s.execute(select(EventDefinition).where(EventDefinition.id == other_id))).scalar_one()
            assert other.block_template == other_template, "no other row is touched"

            await _run(s, _m0475(), "downgrade")
            assert (await _row(s)).block_template == _m0474()._BLOCK_TEMPLATE_AFTER
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_an_instruction_with_a_work_item_carries_the_targets_name_and_the_work_items_title():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _at_0475(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="발행자")
            target_id = await _seed_agent(s, org_id, project_id, name="미르코")
            story_id = await _seed_story(s, org_id, project_id, human_owner_member_id=target_id)
            _resp, event = await _publish(s, org_id=org_id, publisher_id=publisher_id, payload={
                "work_item_type": "story", "work_item_id": str(story_id), "target_member_id": str(target_id), "instruction": "먼저 봐 주세요",
            })
            refs = event.get("refs") or {}
            assert refs.get("target") == {"found": True, "name": "미르코"}
            assert refs.get("work_item", {}).get("found") is True and f"entity:story:{story_id}" in refs["work_item"]["token"]
            assert "issued_by" not in refs, "no issuer in the payload → no ref (nothing is invented)"
            # the summary the bell / live frames carry for this message (story 4921, second PR) is the human line — never the machine text an agent reads
            from app.models.conversation import ConversationMessage
            from app.models.team import TeamMember
            from app.routers.conversations import _msg_payload

            msg = (await s.execute(select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(_resp["message_id"])))).scalar_one()
            assert msg.content.startswith("[이벤트] "), "the stored content stays the agents' text"
            sender = (await s.execute(select(TeamMember).where(TeamMember.id == msg.sender_id))).scalar_one()
            summary = _msg_payload(msg, sender)["summary"]
            assert "방향 전환 · 먼저 봐 주세요 → 미르코" in summary
            assert "[이벤트]" not in summary and "preset.steer" not in summary and str(target_id) not in summary and "work_item" not in summary
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_an_instruction_without_a_work_item_carries_the_target_only():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _at_0475(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="발행자")
            target_id = await _seed_agent(s, org_id, project_id, name="미르코")
            _resp, event = await _publish(s, org_id=org_id, publisher_id=publisher_id, payload={"target_member_id": str(target_id), "instruction": "이제 A로 가자"})
            refs = event.get("refs") or {}
            assert refs.get("target") == {"found": True, "name": "미르코"}
            assert "work_item" not in refs
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_an_issuer_that_cannot_be_named_is_found_false_and_a_named_one_is_named():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _at_0475(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="발행자")
            target_id = await _seed_agent(s, org_id, project_id, name="미르코")
            _r1, ev_named = await _publish(s, org_id=org_id, publisher_id=publisher_id, payload={
                "target_member_id": str(target_id), "instruction": "지시", "issued_by_member_id": str(publisher_id),
            })
            assert (ev_named.get("refs") or {}).get("issued_by") == {"found": True, "name": "발행자"}
            _r2, ev_gone = await _publish(s, org_id=org_id, publisher_id=publisher_id, payload={
                "target_member_id": str(target_id), "instruction": "지시", "issued_by_member_id": str(uuid.uuid4()),
            })
            assert (ev_gone.get("refs") or {}).get("issued_by") == {"found": False}, "an unknown member is not given a made-up name"
    finally:
        await engine.dispose()
