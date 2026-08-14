"""story #2637 §범위1/5 — POST/PATCH /api/v2/events/definitions의 block_template 등록 게이트.

validate_block_template 단위 테스트(test_2637_block_template_validation.py)는 이미 구조
계약을 고정했다 — 여기는 그게 실제 등록/수정 엔드포인트에 배선됐는지만 확인한다.
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


_VALID_SCHEMA = {"type": "object", "additionalProperties": False}
_NONE_ROUTING = {
    "escalation": {"kind": "server_derived", "target": "none"},
    "broadcast": {"kind": "server_derived", "target": "none"},
}
_VALID_TEMPLATE = {"blocks": [{"type": "header", "text": "제목"}]}


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_register_with_valid_block_template():
    from app.routers.events import CreateEventDefinitionRequest, create_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="admin")

            resp = await create_event_definition(
                CreateEventDefinitionRequest(
                    key="org.acme.widget.made", payload_schema=_VALID_SCHEMA,
                    routing=_NONE_ROUTING, block_template=_VALID_TEMPLATE,
                ),
                db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
            )
            assert resp.block_template == _VALID_TEMPLATE
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_register_without_block_template_stays_none():
    """block_template 미지정 = 현행 제네릭 폴백(비회귀) — None으로 저장."""
    from app.routers.events import CreateEventDefinitionRequest, create_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="admin")

            resp = await create_event_definition(
                CreateEventDefinitionRequest(
                    key="org.acme.widget.made", payload_schema=_VALID_SCHEMA, routing=_NONE_ROUTING,
                ),
                db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
            )
            assert resp.block_template is None
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_register_rejects_invalid_block_template():
    from app.routers.events import CreateEventDefinitionRequest, create_event_definition

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_org_member(s, org_id, role="admin")

            with pytest.raises(HTTPException) as ei:
                await create_event_definition(
                    CreateEventDefinitionRequest(
                        key="org.acme.widget.made", payload_schema=_VALID_SCHEMA,
                        routing=_NONE_ROUTING, block_template={"blocks": [{"type": "carousel"}]},
                    ),
                    db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_patch_block_template_bumps_version_and_revalidates():
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
                uuid.UUID(created.id), UpdateEventDefinitionRequest(block_template=_VALID_TEMPLATE),
                db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
            )
            assert updated.version == 2
            assert updated.block_template == _VALID_TEMPLATE

            with pytest.raises(HTTPException) as ei:
                await update_event_definition(
                    uuid.UUID(created.id),
                    UpdateEventDefinitionRequest(block_template={"blocks": []}),
                    db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()
