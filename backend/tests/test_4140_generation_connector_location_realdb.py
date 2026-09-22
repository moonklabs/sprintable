"""story #4140([E-RECIPE-1·Phase 3 폴리시] 연산 커넥터 리전 정책, 페드루 PO 처방
2026-09-22) — 2호 실사고(aa1c2330·gemini-2.5-flash-image가 asia-northeast3에서 404 →
댄군 자체 판단으로 global 재시도, «어느 리전을 쓸지»가 제품 밖 재량에 있던 문제)의
직접 처방. 30분 실측(미르코, 같은 날) 결과 이 코드베이스에 location 필드 자체가 어디에도
없었고(model_config_json은 모달리티별 모델-id만 담음, org_generation_connectors.py 참조),
PO가 그 실측대로 카드를 좁혔다: 라이브 Vertex 프로빙(커넥터별 동적 자격 전례 0, 2pt 밖)도
정적 모델별 가용성 표(2호 404 한 건뿐이라 추측 표)도 기각 — 남는 근본만 제품 값으로:
model_config_json.location(허용 목록 검증·기본 global) + 응답 노출(crew 재량 0).

허용 목록·기본값 근거는 app/models/org_generation_connector.py의
GENERATION_CONNECTOR_LOCATIONS/DEFAULT_GENERATION_CONNECTOR_LOCATION 주석 참조(이 세션에서
실제 확認된 값 2개만 — 추측 0 원칙).

세팅 헬퍼는 test_4101_generation_connector_realdb.py를 그대로 미러(발명 0)."""
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
    """test_4101_generation_connector_realdb.py의 crypto 시크릿 격리 관례 그대로 미러."""
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


async def _seed_org_project(session, *, slug="e4140"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org4140", slug=slug)
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


async def _seed_generation_connector_without_location(session, org_id, *, label="legacy"):
    """마이그레이션 0으로 남는 «기존 커넥터»(location 키 자체가 model_config_json에
    없던 시절 등록분) 재현 — API 경로가 아니라 행을 직접 심어 시뮬레이션한다."""
    from app.models.org_generation_connector import OrgGenerationConnector
    from app.services.generation_connector_credential_crypto import encrypt_generation_connector_credential

    c = OrgGenerationConnector(
        id=uuid.uuid4(), org_id=org_id, provider_key="vertex_gemini", label=label,
        model_config_json={"image": "gemini-2.5-flash-image"},  # location 키 없음(의도)
        encrypted_credentials=encrypt_generation_connector_credential("super-secret-api-key"),
        status="active",
    )
    session.add(c)
    await session.commit()
    return c.id


def _auth(user_id: uuid.UUID, org_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(org_id))


# ─── AC1 — 기본 global(신규 등록, location 키 미제공) ──────────────────────────


@pytest.mark.anyio
async def test_create_without_location_defaults_to_global():
    from app.routers.org_generation_connectors import (
        GenerationConnectorCreateRequest, create_generation_connector_endpoint,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s)
            _admin_id, admin_user_id = await _seed_org_member(s, org_id, role="admin")

            resp = await create_generation_connector_endpoint(
                org_id,
                GenerationConnectorCreateRequest(
                    provider_key="vertex_gemini", label="기본 리전",
                    model_config_json={"image": "gemini-2.5-flash-image"}, credentials="sk-x",
                ),
                db=s, auth=_auth(admin_user_id, org_id), verified_org_id=org_id,
            )
            assert resp.location == "global"
    finally:
        await engine.dispose()


# ─── AC2 — 명시 리전 저장 → 응답 반영 ──────────────────────────────────────────


@pytest.mark.anyio
async def test_create_with_explicit_location_is_persisted_and_returned():
    from app.routers.org_generation_connectors import (
        GenerationConnectorCreateRequest, create_generation_connector_endpoint,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s)
            _admin_id, admin_user_id = await _seed_org_member(s, org_id, role="admin")

            resp = await create_generation_connector_endpoint(
                org_id,
                GenerationConnectorCreateRequest(
                    provider_key="vertex_gemini", label="명시 리전",
                    model_config_json={"image": "gemini-2.5-flash-image", "location": "asia-northeast3"},
                    credentials="sk-x",
                ),
                db=s, auth=_auth(admin_user_id, org_id), verified_org_id=org_id,
            )
            assert resp.location == "asia-northeast3"
            assert resp.model_config_json["location"] == "asia-northeast3"
    finally:
        await engine.dispose()


# ─── AC3 — 허용 목록 밖 값 → 422 ──────────────────────────────────────────────


@pytest.mark.anyio
async def test_create_with_unsupported_location_returns_422():
    from app.routers.org_generation_connectors import (
        GenerationConnectorCreateRequest, create_generation_connector_endpoint,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s)
            _admin_id, admin_user_id = await _seed_org_member(s, org_id, role="admin")

            with pytest.raises(HTTPException) as exc_info:
                await create_generation_connector_endpoint(
                    org_id,
                    GenerationConnectorCreateRequest(
                        provider_key="vertex_gemini", label="허용 밖 리전",
                        model_config_json={"location": "mars-east1"}, credentials="sk-x",
                    ),
                    db=s, auth=_auth(admin_user_id, org_id), verified_org_id=org_id,
                )
            assert exc_info.value.status_code == 422
    finally:
        await engine.dispose()


# ─── AC4 — 기존 커넥터(location 없음) 응답 = global ────────────────────────────


@pytest.mark.anyio
async def test_list_existing_connector_without_location_resolves_to_global():
    from app.routers.org_generation_connectors import list_generation_connectors_endpoint

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s)
            _member_id, member_user_id = await _seed_org_member(s, org_id, role="member")
            await _seed_generation_connector_without_location(s, org_id)

            resp = await list_generation_connectors_endpoint(
                org_id, active_only=False, db=s, auth=_auth(member_user_id, org_id), verified_org_id=org_id,
            )
            assert len(resp.connectors) == 1
            assert resp.connectors[0].location == "global"
            # 원본 model_config_json은 그대로(location 키를 몰래 끼워 넣지 않는다) —
            # location은 별도 top-level 필드로만 해소값을 싣는다(response DTO 계약).
            assert "location" not in resp.connectors[0].model_config_json
    finally:
        await engine.dispose()
