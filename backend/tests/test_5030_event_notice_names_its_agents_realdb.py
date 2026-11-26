"""story 5030 (C0) — an event notice is ADDRESSED: the publisher names the members its routing chose, so «an agent in a group room hears only the words that call it» does not silence them.

`preset.work.status_changed` / `preset.gate.verdict` / `preset.work.assigned` route to the work item's stakeholders on the BROADCAST leg; only the ESCALATION leg was ever called (`mentioned_ids`).
The notice reached its agents because «an agent hears everything» was the default. With the default flipped (5030) a notice that calls nobody reaches nobody — exactly the notice that is the agent's work
(PO 11-26: «맡은 일 알림 — 받을 사람이 정해져 있음»). The addressees are NOT put in `mentioned_ids` (a call adds a second event and a bell line — test_4451 counts one delivery per stage); they are
named in the server-only `msg_metadata['delivery']`. Real PG on the migrated schema (the preset definitions are migration seeds), the real publisher, the real router.

  · the stakeholder AGENT is named and receives it exactly once; an unrelated agent of the organization receives nothing
  · a stakeholder PERSON is not added to the mentions (no extra bell line) and still receives it (a person's default is `all`)
  · nobody can name itself an addressee through the public route (422)
"""
from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest
from sqlalchemy import select

from tests.test_1994_backlink_api_realdb import _make_agent_member, _make_org, _make_project, _session_factory
from tests.test_2288_command_center_gate_type_waiting_realdb import _make_member
from tests.test_2301_story_body_mentions_realdb import _REAL_DB_URL

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _id(member) -> uuid.UUID:
    return member if isinstance(member, uuid.UUID) else member.id


async def _the_notice_of(s, org_id):
    """the message the publisher put in this organization's event room (the only one the organization has)."""
    from app.models.conversation import Conversation, ConversationMessage

    return (await s.execute(
        select(ConversationMessage)
        .join(Conversation, Conversation.id == ConversationMessage.conversation_id)
        .where(Conversation.org_id == org_id)
        .order_by(ConversationMessage.created_at.desc())
        .limit(1)
    )).scalars().one()


async def test_a_status_notice_calls_its_stakeholder_agent_and_reaches_that_agent_only():
    from app.models.pm import Story
    from app.routers.events import publish_preset_event
    from app.services.channel_router import route_message

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            owner = _id(await _make_agent_member(s, org.id, project.id))
            stranger = _id(await _make_agent_member(s, org.id, project.id))  # an agent of the organization the story is not about
            story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="in-progress", assignee_id=owner)
            s.add(story)
            await s.commit()

            with patch("app.core.database.async_session_factory", Session):
                result = await publish_preset_event(s, org.id, "preset.work.status_changed", {
                    "work_item_type": "story", "work_item_id": str(story.id),
                    "from_status": "in-progress", "to_status": "in-review",
                })
                await s.commit()
            assert result is not None and not result["zero_reach_warning"], result

            notice = await _the_notice_of(s, org.id)
            named = (notice.msg_metadata or {}).get("delivery", {}).get("member_ids", [])
            assert str(owner) in named, "the stakeholder agent must be named as an addressee"
            assert str(stranger) not in named
            assert owner not in (notice.mentioned_ids or []), "named, not called: a call would add a second event for the same notice"

            heard = {d.member_id for d in await route_message(notice.id, s)}
            assert owner in heard, "the agent the notice is about must receive it though a group room delivers only the called words"
            assert stranger not in heard

            # exactly once: one message event for the addressee and no mention event (a call would have added one — test_4451 counts one delivery per stage)
            from app.models.event import Event

            rows = (await s.execute(
                select(Event.event_type).where(Event.source_entity_id == notice.id, Event.recipient_id == owner)
            )).scalars().all()
            assert rows.count("conversation.message_created") == 1 and "conversation:mention" not in rows, rows
    finally:
        await engine.dispose()


async def test_the_public_route_refuses_a_caller_that_names_its_own_addressees():
    from pydantic import ValidationError

    from app.routers.conversations import HttpSendMessageRequest, SendMessageRequest

    with pytest.raises(ValidationError):
        HttpSendMessageRequest(content="x", delivery_member_ids=[uuid.uuid4()])
    # the in-process publisher keeps the field
    assert SendMessageRequest(content="x", delivery_member_ids=[uuid.uuid4()]).delivery_member_ids


async def test_a_stakeholder_person_is_not_added_to_the_mentions_but_still_receives_the_notice():
    from app.models.pm import Story
    from app.routers.events import publish_preset_event
    from app.services.channel_router import route_message

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            agent = _id(await _make_agent_member(s, org.id, project.id))
            person, _user = await _make_member(s, org.id, project.id)
            story = Story(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="in-progress",
                assignee_id=agent, human_owner_member_id=person,
            )
            s.add(story)
            await s.commit()

            with patch("app.core.database.async_session_factory", Session):
                await publish_preset_event(s, org.id, "preset.work.status_changed", {
                    "work_item_type": "story", "work_item_id": str(story.id),
                    "from_status": "in-progress", "to_status": "in-review",
                })
                await s.commit()

            notice = await _the_notice_of(s, org.id)
            assert agent not in (notice.mentioned_ids or [])
            assert person not in (notice.mentioned_ids or []), "a person is not called — that would add a bell line they did not have"
            heard = {d.member_id for d in await route_message(notice.id, s)}
            assert {agent, person} <= heard, heard
    finally:
        await engine.dispose()
