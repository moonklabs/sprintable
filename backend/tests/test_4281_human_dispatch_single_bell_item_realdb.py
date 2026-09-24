"""story #4281(유나 추론 · PO 18:53Z «먼저 잰다») — 사람에게 한 번 맡기면 사람 쪽 기록이 몇 개 생기는가.

`agent_dispatch._finalize_dispatch`가 수신자 Event(dispatched)를 만들고, 사람이면 이어 `dispatch_notification`을 부르는데 그 안에서
사람 몫 Event(dispatched · delivered)를 **또** 만든다. 종(`/api/v2/event-notifications`)은 수신자 Event를 그대로 세고 보여 주므로
한 번 맡김이 종에 둘로 뜬다. 알림 탭(`/api/v2/notifications`)은 Notification 행이라 하나.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import func, select

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


@pytest.mark.anyio
async def test_one_dispatch_to_a_person_leaves_one_bell_item_and_one_notification():
    from app.models.event import Event
    from app.models.notification import Notification
    from app.services.agent_dispatch import dispatch_entity_to_assignee
    from tests.test_ccbcd9da_gate_wake_wiring_realdb import _session
    from tests.test_3414_publication_command_core import _seed_human, _seed_org, _seed_story

    engine, Session = await _session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org(s)
            user_id = await _seed_human(s, org_id)
            from app.models.team import TeamMember

            member = TeamMember(
                id=uuid.uuid4(), org_id=org_id, project_id=project_id, user_id=user_id, type="human",
                name="사람", role="member", is_active=True,
            )
            s.add(member)
            await s.commit()
            human_member_id = member.id
            story_id = await _seed_story(s, org_id, project_id)
            from app.models.pm import Story

            story = await s.get(Story, story_id)
            story.assignee_id = human_member_id
            await s.commit()

        async with Session() as s:
            resp, _delivery = await dispatch_entity_to_assignee(s, org_id, "story", story_id, message="리뷰 부탁")
        assert resp.dispatched, resp

        async with Session() as s:
            events = (await s.execute(select(func.count()).select_from(Event).where(
                Event.recipient_id == human_member_id, Event.event_type == "dispatched",
            ))).scalar_one()
            notifications = (await s.execute(select(func.count()).select_from(Notification).where(
                Notification.reference_id == story_id, Notification.user_id == user_id,
            ))).scalar_one()
        assert notifications == 1
        assert events == 1, f"한 번 맡겼는데 종(수신자 Event)에 {events}개"
    finally:
        await engine.dispose()
