"""story #2637 §0-c — PUT /api/v2/notification-preferences의 event_key 축 CRUD 검증.

scope_type="event_key"↔event_key 상호배타 강제, upsert 멱등(같은 (member, event_key,
channel)로 재호출 시 update만).
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _realdb_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project(session, *, slug="acme"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2637pref", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_upsert_event_key_scope_succeeds():
    from app.routers.notification_preferences import (
        PreferenceItem, UpsertPreferencesRequest, upsert_preferences,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)

            resp = await upsert_preferences(
                UpsertPreferencesRequest(preferences=[
                    PreferenceItem(scope_type="event_key", event_key="org.acme.widget.made",
                                    channel="sse", level="mute"),
                ]),
                db=s, auth=_auth(agent_id, org_id), org_id=org_id,
            )
            assert resp[0]["event_key"] == "org.acme.widget.made"
            assert resp[0]["scope_id"] is None
            assert resp[0]["level"] == "mute"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_upsert_event_key_scope_without_event_key_rejected():
    from app.routers.notification_preferences import (
        PreferenceItem, UpsertPreferencesRequest, upsert_preferences,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)

            with pytest.raises(HTTPException) as ei:
                await upsert_preferences(
                    UpsertPreferencesRequest(preferences=[
                        PreferenceItem(scope_type="event_key", channel="sse", level="mute"),
                    ]),
                    db=s, auth=_auth(agent_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_non_event_key_scope_with_event_key_rejected():
    from app.routers.notification_preferences import (
        PreferenceItem, UpsertPreferencesRequest, upsert_preferences,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)

            with pytest.raises(HTTPException) as ei:
                await upsert_preferences(
                    UpsertPreferencesRequest(preferences=[
                        PreferenceItem(scope_type="global", event_key="org.acme.widget.made",
                                        channel="sse", level="mute"),
                    ]),
                    db=s, auth=_auth(agent_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_upsert_event_key_scope_is_idempotent_update():
    from app.routers.notification_preferences import (
        PreferenceItem, UpsertPreferencesRequest, upsert_preferences,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)

            item = PreferenceItem(
                scope_type="event_key", event_key="org.acme.widget.made", channel="sse", level="mute",
            )
            first = await upsert_preferences(
                UpsertPreferencesRequest(preferences=[item]), db=s, auth=_auth(agent_id, org_id), org_id=org_id,
            )
            second = await upsert_preferences(
                UpsertPreferencesRequest(preferences=[
                    PreferenceItem(scope_type="event_key", event_key="org.acme.widget.made",
                                    channel="sse", level="all"),
                ]),
                db=s, auth=_auth(agent_id, org_id), org_id=org_id,
            )
            assert first[0]["id"] == second[0]["id"]
            assert second[0]["level"] == "all"

            from app.models.notification_preference import NotificationPreference
            from sqlalchemy import select

            count = (await s.execute(
                select(NotificationPreference).where(NotificationPreference.member_id == agent_id)
            )).scalars().all()
            assert len(count) == 1
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_distinct_event_keys_do_not_collide():
    from app.routers.notification_preferences import (
        PreferenceItem, UpsertPreferencesRequest, upsert_preferences,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)

            await upsert_preferences(
                UpsertPreferencesRequest(preferences=[
                    PreferenceItem(scope_type="event_key", event_key="org.acme.widget.made",
                                    channel="sse", level="mute"),
                ]),
                db=s, auth=_auth(agent_id, org_id), org_id=org_id,
            )
            resp = await upsert_preferences(
                UpsertPreferencesRequest(preferences=[
                    PreferenceItem(scope_type="event_key", event_key="org.acme.thing.done",
                                    channel="sse", level="mute"),
                ]),
                db=s, auth=_auth(agent_id, org_id), org_id=org_id,
            )
            assert resp[0]["event_key"] == "org.acme.thing.done"

            from app.routers.notification_preferences import get_preferences

            all_prefs = await get_preferences(db=s, auth=_auth(agent_id, org_id), org_id=org_id)
            assert len(all_prefs) == 2
    finally:
        await engine.dispose()
