"""story #2636(P1b) — POST/PATCH /api/v2/events/definitions(org 커스텀 이벤트 등록).

doc event-registry-p1b-custom-registration-detail. 검증 축:
- AC1: additionalProperties 미선언 payload_schema는 등록 거부(양성·음성).
- AC2: escalation-none 표현(target=none) 허용 — server_derived 그 외 target은 여전히 금지.
- 네임스페이스 도용 차단(#2632 게이트 재사용 확인), org-admin/owner 게이트, 409 중복,
  soft delete(enabled=false) + version 범프, cross-org 404.
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


async def _seed_org(session, *, slug="acme"):
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


def _human_auth(user_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(user_id), email="admin@example.com",
        claims={"app_metadata": {"org_id": str(org_id)}}, org_id=str(org_id),
    )


_VALID_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {"widget_id": {"type": "string"}}, "required": ["widget_id"],
}
_NONE_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}


# ─── AC1: additionalProperties 게이트 ───────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_register_rejects_schema_without_additional_properties_false():
    from app.routers.events import CreateEventDefinitionRequest, create_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="admin")

            body = CreateEventDefinitionRequest(
                key="org.acme.widget.made",
                payload_schema={"type": "object", "properties": {"widget_id": {"type": "string"}}},
                routing=_NONE_ROUTING,
            )
            with pytest.raises(HTTPException) as ei:
                await create_event_definition(body, db=s, auth=_human_auth(user_id, org_id), org_id=org_id)
            assert ei.value.status_code == 400
            assert ei.value.detail["code"] == "invalid_definition"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_register_accepts_schema_with_additional_properties_false():
    from app.routers.events import CreateEventDefinitionRequest, create_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="admin")

            body = CreateEventDefinitionRequest(
                key="org.acme.widget.made", payload_schema=_VALID_SCHEMA, routing=_NONE_ROUTING,
            )
            resp = await create_event_definition(body, db=s, auth=_human_auth(user_id, org_id), org_id=org_id)
            assert resp.key == "org.acme.widget.made"
            assert resp.enabled is True
            assert resp.version == 1
    finally:
        await engine.dispose()


# ─── AC2: escalation-none 표현 ───────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_register_allows_target_none_despite_server_derived_ban():
    """target=none은 allow_server_derived=False에서도 예외적으로 통과해야 한다."""
    from app.routers.events import CreateEventDefinitionRequest, create_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="owner")

            body = CreateEventDefinitionRequest(
                key="org.acme.thing.done", payload_schema=_VALID_SCHEMA,
                routing={
                    "escalation": {"kind": "server_derived", "target": "none"},
                    "broadcast": {"kind": "payload_field", "member_id_field": "actor_member_id"},
                },
            )
            resp = await create_event_definition(body, db=s, auth=_human_auth(user_id, org_id), org_id=org_id)
            assert resp.routing["escalation"]["target"] == "none"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_register_still_rejects_other_server_derived_targets():
    """target=none 예외가 server_derived 전면 금지를 무너뜨리면 안 된다 — work_item_stakeholders
    등 다른 target은 여전히 거부."""
    from app.routers.events import CreateEventDefinitionRequest, create_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="admin")

            body = CreateEventDefinitionRequest(
                key="org.acme.thing.escalated", payload_schema=_VALID_SCHEMA,
                routing={
                    "escalation": {"kind": "server_derived", "target": "work_item_stakeholders"},
                    "broadcast": {"kind": "server_derived", "target": "none"},
                },
            )
            with pytest.raises(HTTPException) as ei:
                await create_event_definition(body, db=s, auth=_human_auth(user_id, org_id), org_id=org_id)
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()


# ─── 네임스페이스 도용 차단(#2632 게이트 재사용 확인) ──────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_register_rejects_mismatched_org_slug_namespace():
    from app.routers.events import CreateEventDefinitionRequest, create_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s, slug="acme")
            user_id = await _seed_org_member(s, org_id, role="admin")

            body = CreateEventDefinitionRequest(
                key="org.globex.widget.made", payload_schema=_VALID_SCHEMA, routing=_NONE_ROUTING,
            )
            with pytest.raises(HTTPException) as ei:
                await create_event_definition(body, db=s, auth=_human_auth(user_id, org_id), org_id=org_id)
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_register_rejects_preset_prefixed_key():
    from app.routers.events import CreateEventDefinitionRequest, create_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="admin")

            body = CreateEventDefinitionRequest(
                key="preset.work.status_changed", payload_schema=_VALID_SCHEMA, routing=_NONE_ROUTING,
            )
            with pytest.raises(HTTPException) as ei:
                await create_event_definition(body, db=s, auth=_human_auth(user_id, org_id), org_id=org_id)
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()


# ─── org-admin 게이트 ───────────────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_register_rejects_non_admin_member():
    from app.routers.events import CreateEventDefinitionRequest, create_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="member")

            body = CreateEventDefinitionRequest(
                key="org.acme.widget.made", payload_schema=_VALID_SCHEMA, routing=_NONE_ROUTING,
            )
            with pytest.raises(HTTPException) as ei:
                await create_event_definition(body, db=s, auth=_human_auth(user_id, org_id), org_id=org_id)
            assert ei.value.status_code == 403
    finally:
        await engine.dispose()


# ─── 409 중복 ────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_register_duplicate_key_409():
    from app.routers.events import CreateEventDefinitionRequest, create_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="admin")

            body = CreateEventDefinitionRequest(
                key="org.acme.widget.made", payload_schema=_VALID_SCHEMA, routing=_NONE_ROUTING,
            )
            await create_event_definition(body, db=s, auth=_human_auth(user_id, org_id), org_id=org_id)
            with pytest.raises(HTTPException) as ei:
                await create_event_definition(body, db=s, auth=_human_auth(user_id, org_id), org_id=org_id)
            assert ei.value.status_code == 409
    finally:
        await engine.dispose()


# ─── PATCH: soft delete + version 범프 ───────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_patch_enabled_false_soft_deletes_without_version_bump():
    from app.routers.events import (
        CreateEventDefinitionRequest, UpdateEventDefinitionRequest,
        create_event_definition, update_event_definition,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="admin")

            created = await create_event_definition(
                CreateEventDefinitionRequest(
                    key="org.acme.widget.made", payload_schema=_VALID_SCHEMA, routing=_NONE_ROUTING,
                ),
                db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
            )
            updated = await update_event_definition(
                uuid.UUID(created.id), UpdateEventDefinitionRequest(enabled=False),
                db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
            )
            assert updated.enabled is False
            assert updated.version == 1
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_patch_payload_schema_bumps_version_and_revalidates():
    from app.routers.events import (
        CreateEventDefinitionRequest, UpdateEventDefinitionRequest,
        create_event_definition, update_event_definition,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="admin")

            created = await create_event_definition(
                CreateEventDefinitionRequest(
                    key="org.acme.widget.made", payload_schema=_VALID_SCHEMA, routing=_NONE_ROUTING,
                ),
                db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
            )
            new_schema = {**_VALID_SCHEMA, "properties": {
                "widget_id": {"type": "string"}, "note": {"type": "string"},
            }}
            updated = await update_event_definition(
                uuid.UUID(created.id), UpdateEventDefinitionRequest(payload_schema=new_schema),
                db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
            )
            assert updated.version == 2
            assert "note" in updated.payload_schema["properties"]

            # 재검증도 걸린다 — additionalProperties 빠뜨린 patch는 거부.
            with pytest.raises(HTTPException) as ei:
                await update_event_definition(
                    uuid.UUID(created.id),
                    UpdateEventDefinitionRequest(payload_schema={"type": "object"}),
                    db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_patch_cross_org_definition_404():
    from app.routers.events import (
        CreateEventDefinitionRequest, UpdateEventDefinitionRequest,
        create_event_definition, update_event_definition,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_a = await _seed_org(s, slug="acme")
            org_b = await _seed_org(s, slug="globex")
            user_a = await _seed_org_member(s, org_a, role="admin")
            user_b = await _seed_org_member(s, org_b, role="admin")

            created = await create_event_definition(
                CreateEventDefinitionRequest(
                    key="org.acme.widget.made", payload_schema=_VALID_SCHEMA, routing=_NONE_ROUTING,
                ),
                db=s, auth=_human_auth(user_a, org_a), org_id=org_a,
            )
            with pytest.raises(HTTPException) as ei:
                await update_event_definition(
                    uuid.UUID(created.id), UpdateEventDefinitionRequest(enabled=False),
                    db=s, auth=_human_auth(user_b, org_b), org_id=org_b,
                )
            assert ei.value.status_code == 404
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_patch_preset_definition_not_reachable_via_org_scoped_route():
    """org_id IS NULL(플랫폼 프리셋)은 이 org-scoped PATCH로 절대 안 잡힌다."""
    from app.models.event_definition import EventDefinition
    from app.routers.events import UpdateEventDefinitionRequest, update_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="admin")
            preset = EventDefinition(
                id=uuid.uuid4(), key="preset.work.status_changed", org_id=None,
                payload_schema=_VALID_SCHEMA, routing=_NONE_ROUTING,
            )
            s.add(preset)
            await s.commit()

            with pytest.raises(HTTPException) as ei:
                await update_event_definition(
                    preset.id, UpdateEventDefinitionRequest(enabled=False),
                    db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 404
    finally:
        await engine.dispose()
