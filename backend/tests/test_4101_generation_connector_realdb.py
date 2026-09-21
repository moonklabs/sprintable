"""story #4101([E-RECIPE-1] 연산(Compute) 슬롯 1/2) — org_generation_connectors CRUD +
capability.target="generation_connector"가 RecipeRoleBinding.generation_connector_id로
XOR 저장/검증되는지(#4090의 channel_connection target과 동형 패턴, 세 번째 값만 추가).

판별축은 capability.**target**(닫힌 어휘)이지 capability.kind가 아니다 — #4090
test_4090_publisher_channel_binding.py와 완전히 동형 근거(kind='generate'는 기존
live_generation stage가 이미 쓰는 열린 값, #3317 계약 무변)."""
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
    """test_3373_channel_connections_pkce.py의 crypto 시크릿 격리 관례 그대로 미러 —
    @lru_cache(maxsize=1)가 테스트 간 옛 키로 캐시된 MultiFernet을 들고 있으면 이번
    테스트가 새로 생성한 키로 암호화한 값을 복호 못 한다."""
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


async def _seed_org_project(session, *, slug="e4101"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org4101", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_human_caller(session, org_id, project_id, *, name="caller"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="human", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_org_member(session, org_id, *, role="admin", user_id=None):
    """CRUD 라우터의 is_org_owner_or_admin 축(org_members 행) — TeamMember(라우팅 축)와는
    다른 신원 공간(test_3319/test_2118 선례와 동형)."""
    from app.core.security import hash_password
    from app.models.project import OrgMember
    from app.models.user import User

    uid = user_id or uuid.uuid4()
    session.add(User(id=uid, email=f"u-{uid.hex[:8]}@test.com", hashed_password=hash_password("x"), is_active=True, email_verified=True))
    await session.commit()
    member_id = uuid.uuid4()
    session.add(OrgMember(id=member_id, org_id=org_id, user_id=uid, role=role))
    await session.commit()
    return member_id, uid


async def _seed_generation_connector(session, org_id, *, status="active", label="v1", created_by=None):
    from app.models.org_generation_connector import OrgGenerationConnector
    from app.services.generation_connector_credential_crypto import encrypt_generation_connector_credential

    c = OrgGenerationConnector(
        id=uuid.uuid4(), org_id=org_id, provider_key="vertex_gemini", label=label,
        model_config_json={"image": "gemini-2.5-flash-image"},
        encrypted_credentials=encrypt_generation_connector_credential("super-secret-api-key"),
        status=status, created_by=created_by,
    )
    session.add(c)
    await session.commit()
    return c.id


_PAYLOAD_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["structure", "live_generation"]},
        "work_item_type": {"type": "string"}, "work_item_id": {"type": "string", "format": "uuid"},
    },
}
_ROUTING = {"escalation": {"kind": "recipe_role_binding"}, "broadcast": {"kind": "server_derived", "target": "none"}}
_STAGE_METADATA = {
    "structure": {"role": "Director", "action": "구조를 짠다"},
    "live_generation": {
        "role": "Compute", "action": "생성한다",
        "capability": {"kind": "generate", "target": "generation_connector"},
    },
}


async def _seed_definition(session, *, key="preset.e4101.live_generation"):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=key, org_id=None, payload_schema=_PAYLOAD_SCHEMA,
        routing=_ROUTING, stage_metadata=_STAGE_METADATA,
    )
    session.add(d)
    await session.commit()
    return d


def _auth(caller_id: uuid.UUID, org_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(caller_id), email=None, claims={}, org_id=str(org_id))


# ─── ① apply/bindings — generation_connector 세 번째 target ────────────────────


@pytest.mark.anyio
async def test_apply_binds_generation_connector_for_generate_target_stage():
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_definition(s)
            caller_id = await _seed_human_caller(s, org_id, project_id)
            connector_id = await _seed_generation_connector(s, org_id)

            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"live_generation": str(connector_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.ok and resp.bindings_upserted == 1

            from sqlalchemy import select
            from app.models.recipe_role_binding import RecipeRoleBinding
            row = (await s.execute(
                select(RecipeRoleBinding).where(
                    RecipeRoleBinding.org_id == org_id, RecipeRoleBinding.event_definition_key == definition.key,
                    RecipeRoleBinding.stage == "live_generation",
                )
            )).scalar_one()
            assert row.generation_connector_id == connector_id
            assert row.agent_member_id is None
            assert row.channel_connection_id is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_apply_rejects_agent_id_for_generation_target_stage():
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_definition(s)
            caller_id = await _seed_human_caller(s, org_id, project_id)
            agent_id = await _seed_agent(s, org_id, project_id)

            with pytest.raises(HTTPException) as exc_info:
                await apply_recipe_role_bindings(
                    definition.id,
                    ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"live_generation": str(agent_id)}),
                    db=s, auth=_auth(caller_id, org_id), org_id=org_id,
                )
            assert exc_info.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_apply_rejects_revoked_generation_connector():
    """판별 조건 — revoke 뒤 바인딩 대상 불가(스토리 자체 명시)."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_definition(s)
            caller_id = await _seed_human_caller(s, org_id, project_id)
            revoked_id = await _seed_generation_connector(s, org_id, status="revoked")

            with pytest.raises(HTTPException) as exc_info:
                await apply_recipe_role_bindings(
                    definition.id,
                    ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"live_generation": str(revoked_id)}),
                    db=s, auth=_auth(caller_id, org_id), org_id=org_id,
                )
            assert exc_info.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_apply_rejects_generation_connector_from_other_org():
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="e4101-a")
            other_org_id, _ = await _seed_org_project(s, slug="e4101-b")
            definition = await _seed_definition(s)
            caller_id = await _seed_human_caller(s, org_id, project_id)
            other_connector_id = await _seed_generation_connector(s, other_org_id)

            with pytest.raises(HTTPException) as exc_info:
                await apply_recipe_role_bindings(
                    definition.id,
                    ApplyRecipeRoleBindingsRequest(
                        project_id=project_id, role_mapping={"live_generation": str(other_connector_id)},
                    ),
                    db=s, auth=_auth(caller_id, org_id), org_id=org_id,
                )
            assert exc_info.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_apply_mixed_agent_and_generation_stages_regression_for_agent_axis():
    """다른 stage(agent 축) 회귀 0 — #4090 realdb 유지 요구와 같은 증명 축, generation
    target이 섞여도 agent target stage는 그대로 TeamMember로 검증·저장."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings
    from sqlalchemy import select
    from app.models.recipe_role_binding import RecipeRoleBinding

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_definition(s)
            caller_id = await _seed_human_caller(s, org_id, project_id)
            director_agent_id = await _seed_agent(s, org_id, project_id, name="director")
            connector_id = await _seed_generation_connector(s, org_id)

            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(
                    project_id=project_id,
                    role_mapping={"structure": str(director_agent_id), "live_generation": str(connector_id)},
                ),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.ok and resp.bindings_upserted == 2

            rows = {r.stage: r for r in (await s.execute(
                select(RecipeRoleBinding).where(
                    RecipeRoleBinding.org_id == org_id, RecipeRoleBinding.event_definition_key == definition.key,
                )
            )).scalars().all()}
            assert rows["structure"].agent_member_id == director_agent_id
            assert rows["structure"].generation_connector_id is None
            assert rows["live_generation"].generation_connector_id == connector_id
            assert rows["live_generation"].agent_member_id is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_get_bindings_returns_generation_connector_id():
    from app.routers.events import (
        ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings, get_recipe_role_bindings,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            definition = await _seed_definition(s)
            caller_id = await _seed_human_caller(s, org_id, project_id)
            connector_id = await _seed_generation_connector(s, org_id)

            await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"live_generation": str(connector_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )

            resp = await get_recipe_role_bindings(
                definition.id, project_id=None, db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.bindings["live_generation"] == str(connector_id)
    finally:
        await engine.dispose()


# ─── ② org_generation_connectors CRUD ───────────────────────────────────────


@pytest.mark.anyio
async def test_create_generation_connector_admin_succeeds_and_response_has_no_credentials():
    from app.routers.org_generation_connectors import (
        GenerationConnectorCreateRequest, create_generation_connector_endpoint,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s)
            admin_id, admin_user_id = await _seed_org_member(s, org_id, role="admin")

            resp = await create_generation_connector_endpoint(
                org_id,
                GenerationConnectorCreateRequest(
                    provider_key="vertex_gemini", label="첫 연산 커넥터",
                    model_config_json={"image": "gemini-2.5-flash-image"}, credentials="sk-live-abcdef123456",
                ),
                db=s, auth=_auth(admin_user_id, org_id), verified_org_id=org_id,
            )
            assert resp.provider_key == "vertex_gemini"
            assert resp.status == "active"
            # write-only 이중 방어 — 응답 모델 자체에 필드가 없고, 직렬화 전문에도 평문/암호문 0.
            assert not hasattr(resp, "credentials")
            assert not hasattr(resp, "encrypted_credentials")
            dumped = resp.model_dump_json()
            assert "sk-live-abcdef123456" not in dumped
            assert "credentials" not in dumped
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_generation_connector_rejects_non_admin_403():
    from app.routers.org_generation_connectors import (
        GenerationConnectorCreateRequest, create_generation_connector_endpoint,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s)
            _member_id, plain_user_id = await _seed_org_member(s, org_id, role="member")

            with pytest.raises(HTTPException) as exc_info:
                await create_generation_connector_endpoint(
                    org_id,
                    GenerationConnectorCreateRequest(provider_key="vertex_gemini", label="x", credentials="sk-x"),
                    db=s, auth=_auth(plain_user_id, org_id), verified_org_id=org_id,
                )
            assert exc_info.value.status_code == 403
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_create_generation_connector_rejects_unsupported_provider_422():
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
                    GenerationConnectorCreateRequest(provider_key="openai_sora", label="x", credentials="sk-x"),
                    db=s, auth=_auth(admin_user_id, org_id), verified_org_id=org_id,
                )
            assert exc_info.value.status_code == 422
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_list_generation_connectors_org_boundary_403():
    from app.routers.org_generation_connectors import list_generation_connectors_endpoint

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s, slug="e4101-lb-a")
            other_org_id, _ = await _seed_org_project(s, slug="e4101-lb-b")
            _admin_id, admin_user_id = await _seed_org_member(s, org_id, role="admin")

            with pytest.raises(HTTPException) as exc_info:
                await list_generation_connectors_endpoint(
                    other_org_id, db=s, auth=_auth(admin_user_id, org_id), verified_org_id=org_id,
                )
            assert exc_info.value.status_code == 403
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_list_generation_connectors_active_only_filter_excludes_revoked():
    from app.routers.org_generation_connectors import list_generation_connectors_endpoint

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _ = await _seed_org_project(s)
            _admin_id, admin_user_id = await _seed_org_member(s, org_id, role="admin")
            active_id = await _seed_generation_connector(s, org_id, label="active-one", status="active")
            await _seed_generation_connector(s, org_id, label="revoked-one", status="revoked")

            resp = await list_generation_connectors_endpoint(
                org_id, active_only=True, db=s, auth=_auth(admin_user_id, org_id), verified_org_id=org_id,
            )
            ids = {c.id for c in resp.connectors}
            assert ids == {active_id}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_revoke_generation_connector_flips_status_and_blocks_future_binding():
    from app.routers.org_generation_connectors import revoke_generation_connector_endpoint
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            _admin_id, admin_user_id = await _seed_org_member(s, org_id, role="admin")
            caller_id = await _seed_human_caller(s, org_id, project_id)
            connector_id = await _seed_generation_connector(s, org_id)
            definition = await _seed_definition(s)

            resp = await revoke_generation_connector_endpoint(
                org_id, connector_id, db=s, auth=_auth(admin_user_id, org_id), verified_org_id=org_id,
            )
            assert resp.status == "revoked"

            with pytest.raises(HTTPException) as exc_info:
                await apply_recipe_role_bindings(
                    definition.id,
                    ApplyRecipeRoleBindingsRequest(project_id=project_id, role_mapping={"live_generation": str(connector_id)}),
                    db=s, auth=_auth(caller_id, org_id), org_id=org_id,
                )
            assert exc_info.value.status_code == 422
    finally:
        await engine.dispose()
