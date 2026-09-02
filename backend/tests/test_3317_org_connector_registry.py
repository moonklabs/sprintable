"""story #3317(마케팅자동화·레시피 결함, PO 확定 2026-09-02①②③) — org_connector_registry
3 API(POST 스키마·PUT config·GET) 실왕복 검증. 시크릿/미선언 키/타입불일치 거부, 재등록 시
기존 org_config 보존, org 스코프/권한을 고정한다.

fixtures/threads.content-package.json·stibee.content-package.json = 미르코군 plugins/
sprintable-agent-plugins PR#31(head e363f05e7)의 describe_connector wire 출력 원문 그대로
복사(PO 제공, 2026-09-02) — 합성 데이터 아님, 양쪽 계약이 실제로 맞는지 이 파일로 pin."""
from __future__ import annotations

import json
import os
import uuid

import pytest

_FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")


def _load_fixture(name: str) -> dict:
    with open(os.path.join(_FIXTURES_DIR, f"{name}.content-package.json"), encoding="utf-8") as f:
        return json.load(f)

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


async def _seed_org(session, *, slug, owner=True):
    from app.models.organization import Organization
    from app.models.project import OrgMember

    org = Organization(id=uuid.uuid4(), name="Org3317", slug=slug)
    session.add(org)
    await session.commit()
    user_id = uuid.uuid4()
    role = "owner" if owner else "member"
    session.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role=role))
    await session.commit()
    return org.id, user_id


def _auth(user_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email="x@example.com", claims={}, org_id=str(org_id))


_THREADS_FIXTURE = _load_fixture("threads")
_STIBEE_FIXTURE = _load_fixture("stibee")
_THREADS_FIELDS = _THREADS_FIXTURE["fields"]
_STIBEE_FIELDS = _STIBEE_FIXTURE["fields"]


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
@pytest.mark.parametrize("fixture", [_THREADS_FIXTURE, _STIBEE_FIXTURE], ids=["threads", "stibee"])
async def test_post_schema_then_get_roundtrip_matches_plugin_fixture(fixture):
    """⭐핵심 — 미르코군 PR#31 실 wire 픽스처(threads·stibee)로 등록→조회가 원문과 필드
    단위로 내용 동일(fields/requires_env/version/channel 전부 pin) — 양쪽 계약이 실제로
    맞는지 실증."""
    from app.routers.connectors import (
        ConnectorFieldEntry, SetConnectorSchemaRequest, get_connector, post_connector_schema,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, owner_id = await _seed_org(s, slug=f"c3317a-{fixture['connector_key']}")
            body = SetConnectorSchemaRequest(
                version=fixture["version"], channel=fixture["channel"],
                fields=[ConnectorFieldEntry(**f) for f in fixture["fields"]],
                requires_env=fixture["requires_env"],
            )
            created = await post_connector_schema(
                org_id, fixture["connector_key"], body,
                session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
            )
            assert created.connector_key == fixture["connector_key"]
            assert created.version == fixture["version"]
            assert created.channel == fixture["channel"]
            assert created.requires_env == fixture["requires_env"]

            fetched = await get_connector(
                org_id, fixture["connector_key"], session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
            )
            fetched_fields = [f.model_dump(exclude_none=True) for f in fetched.fields]
            assert fetched_fields == fixture["fields"]
            assert fetched.org_config == {}
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_put_config_accepts_declared_keys_with_matching_types():
    from app.routers.connectors import (
        ConnectorFieldEntry, SetConnectorConfigRequest, SetConnectorSchemaRequest,
        post_connector_schema, put_connector_config,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, owner_id = await _seed_org(s, slug="c3317b")
            await post_connector_schema(
                org_id, "stibee",
                SetConnectorSchemaRequest(version="1.0.0", channel="stibee", fields=[ConnectorFieldEntry(**f) for f in _STIBEE_FIELDS]),
                session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
            )
            updated = await put_connector_config(
                org_id, "stibee",
                SetConnectorConfigRequest(config={"create.senderEmail": "hello@example.com", "create.listId": 42}),
                session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
            )
            assert updated.org_config == {"create.senderEmail": "hello@example.com", "create.listId": 42}
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_put_config_rejects_undeclared_key():
    """⭐PO 명시 — 오타/미선언 키가 조용히 통과하면 안 된다(422)."""
    from fastapi import HTTPException
    from app.routers.connectors import (
        ConnectorFieldEntry, SetConnectorConfigRequest, SetConnectorSchemaRequest,
        post_connector_schema, put_connector_config,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, owner_id = await _seed_org(s, slug="c3317c")
            await post_connector_schema(
                org_id, "stibee",
                SetConnectorSchemaRequest(version="1.0.0", channel="stibee", fields=[ConnectorFieldEntry(**f) for f in _STIBEE_FIELDS]),
                session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
            )
            with pytest.raises(HTTPException) as exc:
                await put_connector_config(
                    org_id, "stibee",
                    SetConnectorConfigRequest(config={"apiSecretToken": "shh"}),
                    session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
                )
            assert exc.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_put_config_rejects_type_mismatch():
    """listId(declared type=number)에 문자열을 보내면 422 — PO 확定①."""
    from fastapi import HTTPException
    from app.routers.connectors import (
        ConnectorFieldEntry, SetConnectorConfigRequest, SetConnectorSchemaRequest,
        post_connector_schema, put_connector_config,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, owner_id = await _seed_org(s, slug="c3317d")
            await post_connector_schema(
                org_id, "stibee",
                SetConnectorSchemaRequest(version="1.0.0", channel="stibee", fields=[ConnectorFieldEntry(**f) for f in _STIBEE_FIELDS]),
                session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
            )
            with pytest.raises(HTTPException) as exc:
                await put_connector_config(
                    org_id, "stibee",
                    SetConnectorConfigRequest(config={"create.listId": "not-a-number"}),
                    session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
                )
            assert exc.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_put_config_rejects_array_item_type_mismatch():
    """⭐PO 명시(2026-09-02①, stibee.create.groupIds 실물 대조) — array 필드는 constraints.
    itemType까지 검사한다. 컨테이너는 배열이 맞아도 원소 하나가 문자열이면 422."""
    from fastapi import HTTPException
    from app.routers.connectors import (
        ConnectorFieldEntry, SetConnectorConfigRequest, SetConnectorSchemaRequest,
        post_connector_schema, put_connector_config,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, owner_id = await _seed_org(s, slug="c3317i")
            await post_connector_schema(
                org_id, "stibee",
                SetConnectorSchemaRequest(version="1.0.0", channel="stibee", fields=[ConnectorFieldEntry(**f) for f in _STIBEE_FIELDS]),
                session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
            )
            # 양성대조 — 전부 number면 통과.
            ok = await put_connector_config(
                org_id, "stibee", SetConnectorConfigRequest(config={"create.groupIds": [1, 2, 3]}),
                session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
            )
            assert ok.org_config["create.groupIds"] == [1, 2, 3]

            with pytest.raises(HTTPException) as exc:
                await put_connector_config(
                    org_id, "stibee",
                    SetConnectorConfigRequest(config={"create.groupIds": [1, "two", 3]}),
                    session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
                )
            assert exc.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_post_schema_rejects_value_shaped_requires_env():
    """⭐PO 명시② — requires_env는 환경변수 이름만. 값처럼 보이는 항목(공백·소문자·'='포함)은
    422로 거부(시크릿 값이 섞여 들어오는 사고 방지)."""
    from fastapi import HTTPException
    from app.routers.connectors import ConnectorFieldEntry, SetConnectorSchemaRequest, post_connector_schema

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, owner_id = await _seed_org(s, slug="c3317e")
            with pytest.raises(HTTPException) as exc:
                await post_connector_schema(
                    org_id, "threads",
                    SetConnectorSchemaRequest(
                        version="1.0.0", channel="threads",
                        fields=[ConnectorFieldEntry(**f) for f in _THREADS_FIELDS],
                        requires_env=["sk_live_abc123real-token-value"],
                    ),
                    session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
                )
            assert exc.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_reregistering_schema_preserves_existing_org_config():
    """스키마 재등록(버전 업)이 이미 설정된 org_config 값을 안 지운다 — 안 그러면 재등록마다
    조직이 매번 재설정을 강요받는 회귀."""
    from app.routers.connectors import (
        ConnectorFieldEntry, SetConnectorConfigRequest, SetConnectorSchemaRequest,
        get_connector, post_connector_schema, put_connector_config,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, owner_id = await _seed_org(s, slug="c3317f")
            await post_connector_schema(
                org_id, "stibee",
                SetConnectorSchemaRequest(version="1.0.0", channel="stibee", fields=[ConnectorFieldEntry(**f) for f in _STIBEE_FIELDS]),
                session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
            )
            await put_connector_config(
                org_id, "stibee", SetConnectorConfigRequest(config={"create.senderEmail": "a@b.com"}),
                session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
            )
            # 버전 업 재등록(스키마만 갱신).
            await post_connector_schema(
                org_id, "stibee",
                SetConnectorSchemaRequest(version="1.1.0", channel="stibee", fields=[ConnectorFieldEntry(**f) for f in _STIBEE_FIELDS]),
                session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
            )
            fetched = await get_connector(org_id, "stibee", session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id))
            assert fetched.version == "1.1.0"
            assert fetched.org_config == {"create.senderEmail": "a@b.com"}
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_non_owner_admin_cannot_write():
    """org member(owner/admin 아님)는 스키마 등록·config 설정 둘 다 403."""
    from fastapi import HTTPException
    from app.routers.connectors import (
        ConnectorFieldEntry, SetConnectorSchemaRequest, post_connector_schema,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, member_id = await _seed_org(s, slug="c3317g", owner=False)
            with pytest.raises(HTTPException) as exc:
                await post_connector_schema(
                    org_id, "threads",
                    SetConnectorSchemaRequest(version="1.0.0", channel="threads", fields=[ConnectorFieldEntry(**f) for f in _THREADS_FIELDS]),
                    session=s, verified_org_id=org_id, auth=_auth(member_id, org_id),
                )
            assert exc.value.status_code == 403
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_put_config_before_schema_registered_is_404():
    from fastapi import HTTPException
    from app.routers.connectors import SetConnectorConfigRequest, put_connector_config

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, owner_id = await _seed_org(s, slug="c3317h")
            with pytest.raises(HTTPException) as exc:
                await put_connector_config(
                    org_id, "threads", SetConnectorConfigRequest(config={}),
                    session=s, verified_org_id=org_id, auth=_auth(owner_id, org_id),
                )
            assert exc.value.status_code == 404
    finally:
        await engine.dispose()
