"""story #4166([연산 커넥터·설정 갭·customer-zero], 페드루 PO 確定 2026-09-22) — 3호
실측: 커넥터 리전만 바꾸려면 자격 재발급→새 커넥터 등록→바인딩 재지정→구 커넥터 해지
4단계가 필요했다(등록 POST만 있고 PATCH가 0). 자격 무접촉 «리전 변경» PATCH를 연다.

세팅 헬퍼는 test_4140_generation_connector_location_realdb.py를 그대로 미러(발명 0)."""
from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

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


@pytest.fixture(autouse=True)
def _configure_generation_connector_secret(monkeypatch):
    """test_4101/test_4140의 crypto 시크릿 격리 관례 그대로 미러."""
    import importlib
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    monkeypatch.setattr(
        config_module.settings, "generation_connector_credential_encryption_key", Fernet.generate_key().decode(),
    )
    import app.services.generation_connector_credential_crypto as crypto_module
    importlib.reload(crypto_module)
    yield
    importlib.reload(crypto_module)


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


async def _seed_org_project(session, *, slug="e4166"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org4166", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_org_member(session, org_id, *, role="admin"):
    from app.core.security import hash_password
    from app.models.project import OrgMember
    from app.models.user import User

    uid = uuid.uuid4()
    session.add(User(id=uid, email=f"u-{uid.hex[:8]}@test.com", hashed_password=hash_password("x"), is_active=True, email_verified=True))
    await session.commit()
    member_id = uuid.uuid4()
    session.add(OrgMember(id=member_id, org_id=org_id, user_id=uid, role=role))
    await session.commit()
    return member_id, uid


async def _seed_generation_connector(session, org_id, *, label="conn", location="asia-northeast3", status="active"):
    from app.models.org_generation_connector import OrgGenerationConnector
    from app.services.generation_connector_credential_crypto import encrypt_generation_connector_credential

    encrypted = encrypt_generation_connector_credential("super-secret-api-key")
    c = OrgGenerationConnector(
        id=uuid.uuid4(), org_id=org_id, provider_key="vertex_gemini", label=label,
        model_config_json={"image": "gemini-2.5-flash-image", "location": location},
        encrypted_credentials=encrypted, status=status,
    )
    session.add(c)
    await session.commit()
    return c.id, encrypted


def _auth(user_id: uuid.UUID, org_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(org_id))


# ─── AC1 — admin 200, 자격 무접촉, 다른 model_config_json 키 보존 ────────────────


@pytest.mark.anyio
async def test_admin_patches_location_200_credentials_untouched_other_keys_preserved():
    from app.routers.org_generation_connectors import (
        GenerationConnectorLocationPatchRequest, patch_generation_connector_location_endpoint,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s)
            _admin_id, admin_user_id = await _seed_org_member(s, org_id, role="admin")
            connector_id, original_encrypted = await _seed_generation_connector(
                s, org_id, location="asia-northeast3",
            )

            resp = await patch_generation_connector_location_endpoint(
                org_id, connector_id, GenerationConnectorLocationPatchRequest(location="global"),
                db=s, auth=_auth(admin_user_id, org_id), verified_org_id=org_id,
            )
            assert resp.location == "global"
            assert resp.model_config_json["location"] == "global"
            # 다른 모달리티 키(image)는 그대로 — location만 갱신했다는 직접 증거.
            assert resp.model_config_json["image"] == "gemini-2.5-flash-image"
            # write-only 계약 — 응답 DTO엔 애초에 credentials 필드가 없다.
            assert not hasattr(resp, "credentials")
            assert not hasattr(resp, "encrypted_credentials")

            from app.models.org_generation_connector import OrgGenerationConnector
            from sqlalchemy import select
            row = (await s.execute(
                select(OrgGenerationConnector).where(OrgGenerationConnector.id == connector_id)
            )).scalar_one()
            # 자격 원본 바이트 불변(리전 변경이 자격을 안 건드린다는 끝단 증거).
            assert row.encrypted_credentials == original_encrypted
    finally:
        await engine.dispose()


# ─── AC1 — member 403 ────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_member_role_forbidden():
    from app.routers.org_generation_connectors import (
        GenerationConnectorLocationPatchRequest, patch_generation_connector_location_endpoint,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s)
            _member_id, member_user_id = await _seed_org_member(s, org_id, role="member")
            connector_id, _ = await _seed_generation_connector(s, org_id)

            with pytest.raises(HTTPException) as exc_info:
                await patch_generation_connector_location_endpoint(
                    org_id, connector_id, GenerationConnectorLocationPatchRequest(location="global"),
                    db=s, auth=_auth(member_user_id, org_id), verified_org_id=org_id,
                )
            assert exc_info.value.status_code == 403
    finally:
        await engine.dispose()


# ─── AC1 — 허용 목록 밖 422 ────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_unsupported_location_returns_422():
    from app.routers.org_generation_connectors import (
        GenerationConnectorLocationPatchRequest, patch_generation_connector_location_endpoint,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s)
            _admin_id, admin_user_id = await _seed_org_member(s, org_id, role="admin")
            connector_id, _ = await _seed_generation_connector(s, org_id)

            with pytest.raises(HTTPException) as exc_info:
                await patch_generation_connector_location_endpoint(
                    org_id, connector_id, GenerationConnectorLocationPatchRequest(location="mars-east1"),
                    db=s, auth=_auth(admin_user_id, org_id), verified_org_id=org_id,
                )
            assert exc_info.value.status_code == 422
    finally:
        await engine.dispose()


# ─── AC1 — revoked 커넥터 409 ──────────────────────────────────────────────────


@pytest.mark.anyio
async def test_revoked_connector_returns_409():
    from app.routers.org_generation_connectors import (
        GenerationConnectorLocationPatchRequest, patch_generation_connector_location_endpoint,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s)
            _admin_id, admin_user_id = await _seed_org_member(s, org_id, role="admin")
            connector_id, _ = await _seed_generation_connector(s, org_id, status="revoked")

            with pytest.raises(HTTPException) as exc_info:
                await patch_generation_connector_location_endpoint(
                    org_id, connector_id, GenerationConnectorLocationPatchRequest(location="global"),
                    db=s, auth=_auth(admin_user_id, org_id), verified_org_id=org_id,
                )
            assert exc_info.value.status_code == 409
    finally:
        await engine.dispose()


# ─── AC1 — 존재하지 않는 커넥터 404 ─────────────────────────────────────────────


@pytest.mark.anyio
async def test_unknown_connector_returns_404():
    from app.routers.org_generation_connectors import (
        GenerationConnectorLocationPatchRequest, patch_generation_connector_location_endpoint,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s)
            _admin_id, admin_user_id = await _seed_org_member(s, org_id, role="admin")

            with pytest.raises(HTTPException) as exc_info:
                await patch_generation_connector_location_endpoint(
                    org_id, uuid.uuid4(), GenerationConnectorLocationPatchRequest(location="global"),
                    db=s, auth=_auth(admin_user_id, org_id), verified_org_id=org_id,
                )
            assert exc_info.value.status_code == 404
    finally:
        await engine.dispose()


# ─── AC2 — 바인딩 무변(같은 id), 서비스 계층에서 location 갱신이 crew 조회에 반영 ──


@pytest.mark.anyio
async def test_get_connector_after_patch_reflects_new_location():
    """AC2 — 커넥터 id·바인딩은 그대로인데(같은 행), get_org_generation_connector로
    다시 읽으면(crew의 get_generation_connector가 쓰는 그 경로) 새 location이 보인다."""
    from app.routers.org_generation_connectors import (
        GenerationConnectorLocationPatchRequest, patch_generation_connector_location_endpoint,
    )
    from app.services.org_generation_connector import (
        get_org_generation_connector, resolve_generation_connector_location,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s)
            _admin_id, admin_user_id = await _seed_org_member(s, org_id, role="admin")
            connector_id, _ = await _seed_generation_connector(s, org_id, location="asia-northeast3")

            await patch_generation_connector_location_endpoint(
                org_id, connector_id, GenerationConnectorLocationPatchRequest(location="global"),
                db=s, auth=_auth(admin_user_id, org_id), verified_org_id=org_id,
            )

            row = await get_org_generation_connector(s, org_id=org_id, connector_id=connector_id)
            assert row is not None
            assert row.id == connector_id  # 같은 id — 재등록/재바인딩 없음
            assert resolve_generation_connector_location(row.model_config_json) == "global"
    finally:
        await engine.dispose()


# ─── 감사 로그 1행 ─────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_patch_records_activity_log_row():
    from app.models.activity_log import ActivityLog
    from sqlalchemy import select
    from app.routers.org_generation_connectors import (
        GenerationConnectorLocationPatchRequest, patch_generation_connector_location_endpoint,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s)
            admin_id, admin_user_id = await _seed_org_member(s, org_id, role="admin")
            connector_id, _ = await _seed_generation_connector(s, org_id, location="asia-northeast3")

            await patch_generation_connector_location_endpoint(
                org_id, connector_id, GenerationConnectorLocationPatchRequest(location="global"),
                db=s, auth=_auth(admin_user_id, org_id), verified_org_id=org_id,
            )

            logs = (await s.execute(
                select(ActivityLog).where(
                    ActivityLog.org_id == org_id,
                    ActivityLog.entity_type == "generation_connector",
                    ActivityLog.entity_id == connector_id,
                    ActivityLog.action == "generation_connector_location_changed",
                )
            )).scalars().all()
            assert len(logs) == 1
            assert logs[0].context["from_location"] == "asia-northeast3"
            assert logs[0].context["to_location"] == "global"
    finally:
        await engine.dispose()
