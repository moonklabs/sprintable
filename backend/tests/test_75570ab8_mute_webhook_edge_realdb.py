"""mute+webhook 동시보유 에이전트 총 무전달 재판정(story 75570ab8·E-CANVAS 잔여 BE). 실 PG.

그라운딩(0f428e1e에서 확인한 dispatch_notification 경로 지식 재사용): `active_webhook_member_ids`는
mute를 모른다 — muted 에이전트가 "webhook이 커버한다"고 오판돼 Event insert가 스킵되고,
`_deliver_personal_webhooks`의 자체 mute 체크로 webhook도 스킵돼 **총 무전달**이었다.
mute의 옳은 의미론 = 능동 push(webhook)만 끔·수동 backlog(Event)는 남겨 poll_events로 나중에
발견 가능해야 함(webhook_targeting.py 자체가 명시한 "silent loss 방지" 철학과 정합)."""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

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


async def _seed_org_project_agent(session):
    from app.models.member import Member
    from app.models.organization import Organization
    from app.models.project import Project
    from app.models.project_access import ProjectAccess

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()

    agent = Member(id=uuid.uuid4(), org_id=org.id, type="agent", name="Agent", is_active=True)
    session.add(agent)
    await session.commit()
    session.add(ProjectAccess(id=uuid.uuid4(), project_id=project.id, member_id=agent.id, permission="granted"))
    await session.commit()

    return {"org_id": org.id, "project_id": project.id, "agent_id": agent.id}


async def _add_webhook(session, org_id, member_id, *, active=True):
    from app.models.webhook_config import WebhookConfig
    cfg = WebhookConfig(
        id=uuid.uuid4(), org_id=org_id, member_id=member_id,
        url="https://discord.com/api/webhooks/123/abc", channel="discord", is_active=active,
    )
    session.add(cfg)
    await session.commit()
    return cfg.id


async def _add_global_mute(session, member_id):
    from app.models.notification_preference import NotificationPreference
    pref = NotificationPreference(
        id=uuid.uuid4(), member_id=member_id, scope_type="global", scope_id=None,
        channel="discord", level="mute",
    )
    session.add(pref)
    await session.commit()
    return pref.id


@pytest.mark.anyio
async def test_muted_agent_with_webhook_still_gets_event_fallback():
    """핵심 회귀 케이스: mute+webhook 동시보유 → Event(pending)는 남아야 함(총 무전달 금지)."""
    from sqlalchemy import select

    from app.models.event import Event
    from app.services.notification_dispatch import dispatch_notification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_agent(s)
            await _add_webhook(s, seeded["org_id"], seeded["agent_id"])
            await _add_global_mute(s, seeded["agent_id"])

        async with Session() as s:
            await dispatch_notification(
                s, org_id=seeded["org_id"], event_type="comment.created",
                target_member_ids=[seeded["agent_id"]], title="T", body="B",
                source_project_id=seeded["project_id"],
            )
            await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(
                    Event.org_id == seeded["org_id"], Event.recipient_id == seeded["agent_id"],
                )
            )).scalars().all()
            assert len(rows) == 1, "muted+webhook 조합에서 Event 폴백이 없음 — 총 무전달 회귀"
            assert rows[0].status == "pending"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unmuted_agent_with_webhook_skips_event_as_before():
    """무회귀: mute 없는 webhook-agent는 기존대로 Event insert 스킵(webhook이 실제로 커버)."""
    from sqlalchemy import select

    from app.models.event import Event
    from app.services.notification_dispatch import dispatch_notification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_agent(s)
            await _add_webhook(s, seeded["org_id"], seeded["agent_id"])

        async with Session() as s:
            await dispatch_notification(
                s, org_id=seeded["org_id"], event_type="comment.created",
                target_member_ids=[seeded["agent_id"]], title="T", body="B",
                source_project_id=seeded["project_id"],
            )
            await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(
                    Event.org_id == seeded["org_id"], Event.recipient_id == seeded["agent_id"],
                )
            )).scalars().all()
            assert rows == [], "webhook-only(무음소거) 에이전트는 Event insert 스킵이 기존 동작"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_muted_agent_without_webhook_still_gets_event_no_regression():
    """무회귀: webhook 자체가 없는 muted 에이전트는 원래도 Event insert(mute가 이 경로엔
    영향 없었음 — 이 케이스가 깨지면 내 변경이 범위를 넘어선 것)."""
    from sqlalchemy import select

    from app.models.event import Event
    from app.services.notification_dispatch import dispatch_notification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_agent(s)
            await _add_global_mute(s, seeded["agent_id"])

        async with Session() as s:
            await dispatch_notification(
                s, org_id=seeded["org_id"], event_type="comment.created",
                target_member_ids=[seeded["agent_id"]], title="T", body="B",
                source_project_id=seeded["project_id"],
            )
            await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(
                    Event.org_id == seeded["org_id"], Event.recipient_id == seeded["agent_id"],
                )
            )).scalars().all()
            assert len(rows) == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_inactive_webhook_treated_as_no_webhook_muted_agent_gets_event():
    """비활성 webhook(is_active=False)은 애초 webhook_member_ids 밖 — muted 여부와 무관하게
    Event insert(경계 확인)."""
    from sqlalchemy import select

    from app.models.event import Event
    from app.services.notification_dispatch import dispatch_notification

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed_org_project_agent(s)
            await _add_webhook(s, seeded["org_id"], seeded["agent_id"], active=False)
            await _add_global_mute(s, seeded["agent_id"])

        async with Session() as s:
            await dispatch_notification(
                s, org_id=seeded["org_id"], event_type="comment.created",
                target_member_ids=[seeded["agent_id"]], title="T", body="B",
                source_project_id=seeded["project_id"],
            )
            await s.commit()

        async with Session() as s:
            rows = (await s.execute(
                select(Event).where(
                    Event.org_id == seeded["org_id"], Event.recipient_id == seeded["agent_id"],
                )
            )).scalars().all()
            assert len(rows) == 1
    finally:
        await engine.dispose()
