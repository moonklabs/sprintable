"""story #2791(P0, event-workflow-unification-design-2790) — 역방향 회귀 테스트.

페드루 판정(2026-08-19, 가드③) — system publisher(서버 자동발행 전용 합성 발신자)로
`send_message()`를 호출할 때 `chat_presence.clear_working`/`emit_conversation_working`/
`emit_presence`가 **0회** 호출됨을 직접 assert한다. 이 부수효과(org-wide presence 방출)가
PO 가드레일 테스트(test_e_ui_daegbyeon_9ef0f914_sse_bridge_realdb.py::
test_cross_project_member_does_not_receive_push_hard_gate)를 우연히 깨뜨린 것이 이 fix의
계기 — 그 테스트는 **한 글자도 안 건드리지 않는다**(fix가 옳으면 그 테스트가 저절로 선다).
"""
from __future__ import annotations

import os
import uuid
from unittest.mock import AsyncMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(session):
    """org + project(preset event definitions는 전역 시드 — 0245) + story(in-review)."""
    from app.models.organization import Organization
    from app.models.pm import Story
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    story = Story(id=uuid.uuid4(), org_id=org.id, project_id=project.id, title="S", status="in-review")
    session.add(story)
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "story_id": story.id}


@pytest.mark.anyio
async def test_system_publisher_send_message_emits_zero_presence():
    """publish_preset_event(system publisher 경유)가 emit_presence/emit_conversation_working/
    chat_presence.clear_working을 전혀 호출하지 않는다 — presence는 "지금 활동 중"이라는
    신호인데 system 발신자에겐 그 개념 자체가 성립하지 않는다(가드③ 근거, 우회 아니라
    의미 정정)."""
    from app.routers.events import publish_preset_event

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)

        async with Session() as s:
            with patch("app.services.presence_events.emit_presence", new=AsyncMock()) as presence_mock, \
                 patch("app.services.presence_events.emit_conversation_working", new=AsyncMock()) as working_mock, \
                 patch("app.services.chat_presence.clear_working", new=AsyncMock()) as clear_mock:
                result = await publish_preset_event(
                    s, seeded["org_id"], "preset.work.status_changed",
                    {
                        "work_item_type": "story",
                        "work_item_id": str(seeded["story_id"]),
                        "from_status": "in-review",
                        "to_status": "in-progress",
                    },
                )
                await s.commit()

        assert result is not None, "preset.work.status_changed definition이 전역 시드에 없음(0245 확인 필요)"
        presence_mock.assert_not_awaited()
        working_mock.assert_not_awaited()
        clear_mock.assert_not_awaited()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_human_sender_send_message_still_emits_presence_no_regression():
    """대조군 — 일반 human 발신자는 이 스킵 분기에 안 걸려 기존 presence 방출이 그대로
    유지된다(회귀 없음, system publisher만 좁게 스킵됨을 실증)."""
    from app.models.member import Member
    from app.models.project_access import ProjectAccess
    from app.routers.conversations import SendMessageRequest, send_message
    from app.dependencies.auth import AuthContext
    from fastapi import BackgroundTasks

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s)
            human = Member(id=uuid.uuid4(), org_id=seeded["org_id"], type="human", name="H")
            s.add(human)
            await s.commit()
            s.add(ProjectAccess(
                id=uuid.uuid4(), project_id=seeded["project_id"], member_id=human.id, permission="granted",
            ))
            await s.commit()

        async with Session() as s:
            from app.models.conversation import Conversation, ConversationParticipant

            conv = Conversation(id=uuid.uuid4(), org_id=seeded["org_id"], project_id=seeded["project_id"], type="dm")
            s.add(conv)
            await s.commit()
            s.add(ConversationParticipant(conversation_id=conv.id, member_id=human.id))
            await s.commit()

            auth = AuthContext(
                user_id=str(human.id), email=None,
                claims={"app_metadata": {"api_key_id": "human-team-member"}}, org_id=str(seeded["org_id"]),
            )
            with patch("app.services.presence_events.emit_presence", new=AsyncMock()) as presence_mock:
                await send_message(
                    conv.id, SendMessageRequest(content="hi"), BackgroundTasks(),
                    db=s, auth=auth, org_id=seeded["org_id"],
                )
                await s.commit()

        presence_mock.assert_awaited_once()
    finally:
        await engine.dispose()
