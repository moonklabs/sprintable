"""story #2634 — GET /api/v2/events/definitions (MCP `sprintable_list_event_definitions`의 백엔드 축).

검증 축:
- AC1: 이 org에서 보이는 정의 = 플랫폼 프리셋(org_id NULL) ∪ 이 org 커스텀. 다른 org의
  커스텀 정의는 보이지 않는다(namespace-squat 방지 축과는 별개 — 여기는 단순 가시성).
- AC2: enabled=false인 정의도 숨기지 않고 그대로 노출(publish 시 그 상태로 거부될 것을
  호출자가 미리 알 수 있게 — 조용히 숨기지 않는다는 것이 events.py 엔드포인트 docstring의 명시 설계).
"""
from __future__ import annotations

import uuid

import pytest

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


def _load_seed_definitions():
    import importlib.util
    import os

    spec = importlib.util.spec_from_file_location(
        "_m0245c_2634", os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0245_event_definitions.py"),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return {key: (payload_schema, routing) for key, payload_schema, routing in m._SEED}


async def _seed_preset_definitions(session):
    from app.models.event_definition import EventDefinition

    for key, (payload_schema, routing) in _load_seed_definitions().items():
        session.add(EventDefinition(
            id=uuid.uuid4(), key=key, org_id=None, payload_schema=payload_schema, routing=routing,
        ))
    await session.commit()


async def _seed_org(session, *, slug):
    from app.models.organization import Organization

    org = Organization(id=uuid.uuid4(), name=f"Org-{slug}", slug=slug)
    session.add(org)
    await session.commit()
    return org.id


async def _seed_org_member(session, org_id, *, role="admin"):
    from app.models.project import OrgMember

    user_id = uuid.uuid4()
    session.add(OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role=role))
    await session.commit()
    return user_id


def _human_auth(user_id: uuid.UUID, org_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(user_id), email="admin@example.com",
        claims={"app_metadata": {"org_id": str(org_id)}}, org_id=str(org_id),
    )


async def _seed_custom_definition(session, org_id, *, slug, key_suffix, enabled=True):
    from app.models.event_definition import EventDefinition

    definition = EventDefinition(
        id=uuid.uuid4(), key=f"org.{slug}.{key_suffix}", org_id=org_id,
        payload_schema={"type": "object", "additionalProperties": False},
        routing={
            "escalation": {"kind": "server_derived", "target": "none"},
            "broadcast": {"kind": "server_derived", "target": "none"},
        },
        enabled=enabled,
    )
    session.add(definition)
    await session.commit()
    return definition.id


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_list_returns_presets_and_own_org_custom_only():
    from app.routers.events import list_event_definitions

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_a = await _seed_org(s, slug="acme")
            org_b = await _seed_org(s, slug="globex")
            await _seed_preset_definitions(s)
            await _seed_custom_definition(s, org_a, slug="acme", key_suffix="widget.made")
            await _seed_custom_definition(s, org_b, slug="globex", key_suffix="gadget.made")

            result = await list_event_definitions(db=s, org_id=org_a)
            keys = {r.key for r in result}

            preset_keys = set(_load_seed_definitions().keys())
            assert preset_keys.issubset(keys)
            assert "org.acme.widget.made" in keys
            assert "org.globex.gadget.made" not in keys
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_list_exposes_disabled_definitions_not_hidden():
    from app.routers.events import list_event_definitions

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s, slug="acme2")
            await _seed_custom_definition(s, org_id, slug="acme2", key_suffix="thing.done", enabled=False)

            result = await list_event_definitions(db=s, org_id=org_id)
            match = next(r for r in result if r.key == "org.acme2.thing.done")
            assert match.enabled is False
    finally:
        await engine.dispose()


# story #2663 — GET 목록에서 id가 빠져 있어 PATCH(uuid 필수)로 이어갈 수 없었다(org admin도
# DB를 직접 파야 했던 갭). 아래 두 테스트: ①목록 각 항목에 id 존재 ②그 id로 실제 PATCH 200
# 왕복(양성대조).
@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_list_items_include_id():
    from app.routers.events import list_event_definitions

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s, slug="acme3")
            definition_id = await _seed_custom_definition(s, org_id, slug="acme3", key_suffix="widget.made")

            result = await list_event_definitions(db=s, org_id=org_id)
            match = next(r for r in result if r.key == "org.acme3.widget.made")
            assert match.id == str(definition_id)
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_list_id_round_trips_through_patch():
    """AC2 양성대조: GET 목록에서 얻은 id 그대로 PATCH가 200으로 닿는다(존재하지 않는/변형된
    id가 아니라, 실제 목록 응답의 그 값)."""
    import uuid as _uuid

    from app.routers.events import UpdateEventDefinitionRequest, list_event_definitions, update_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s, slug="acme4")
            admin_id = await _seed_org_member(s, org_id, role="admin")
            await _seed_custom_definition(s, org_id, slug="acme4", key_suffix="widget.patched")

            listed = await list_event_definitions(db=s, org_id=org_id)
            match = next(r for r in listed if r.key == "org.acme4.widget.patched")

            patched = await update_event_definition(
                _uuid.UUID(match.id), UpdateEventDefinitionRequest(enabled=False),
                db=s, auth=_human_auth(admin_id, org_id), org_id=org_id,
            )
            assert patched.id == match.id
            assert patched.enabled is False
    finally:
        await engine.dispose()
