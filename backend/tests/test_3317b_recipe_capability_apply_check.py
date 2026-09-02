"""story #3317 PR B(마케팅자동화·레시피 결함, PO 확定 2026-09-02) — stage_metadata.capability
선언 shape 검증 + apply 시 org_connector_registry(PR A) 대조 warnings[] 실증.

kind 매칭 테스트는 미르코군 plugins/sprintable-agent-plugins PR#33(head e30be0940, 0.8.1)의
실 wire 픽스처(threads.kinds=["publish","measure"]·stibee.kinds=["publish"], 페드루 제공
2026-09-02)를 그대로 쓴다 — tests/fixtures/*.content-package.json 참조."""
from __future__ import annotations

import json
import os
import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")
_FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")


def _load_fixture(name: str) -> dict:
    with open(os.path.join(_FIXTURES_DIR, f"{name}.content-package.json"), encoding="utf-8") as f:
        return json.load(f)


pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── 단위 축 — validate_stage_metadata의 capability shape 강제(DB 불요) ────────────


def test_validate_stage_metadata_accepts_valid_capability_with_connector_key():
    from app.services.event_definition_registry import validate_stage_metadata

    schema = {"properties": {"stage": {"enum": ["publish"]}}}
    validate_stage_metadata(schema, {
        "publish": {
            "role": "Agent", "action": "발행",
            "capability": {"kind": "publish", "connector_key": "threads"},
        },
    })  # raise 없으면 통과


def test_validate_stage_metadata_accepts_capability_without_connector_key():
    """PO 확定 — connector_key는 선택. kind만으로도 유효(apply 시 느슨 매칭 대상)."""
    from app.services.event_definition_registry import validate_stage_metadata

    schema = {"properties": {"stage": {"enum": ["publish"]}}}
    validate_stage_metadata(schema, {
        "publish": {"role": "Agent", "action": "발행", "capability": {"kind": "publish"}},
    })


def test_validate_stage_metadata_accepts_org_defined_kind_not_publish():
    """⭐PO 확定(2026-09-02) — kind는 닫힌 어휘가 아니다. 'collect'/'measure'/'read' 등
    조직이 뜻을 정하는 임의 문자열도 통과(서버는 뜻을 안 따짐, 비어있지 않은 문자열만
    강제)."""
    from app.services.event_definition_registry import validate_stage_metadata

    schema = {"properties": {"stage": {"enum": ["monitor"]}}}
    validate_stage_metadata(schema, {
        "monitor": {"role": "Agent", "action": "수집", "capability": {"kind": "collect"}},
    })


def test_validate_stage_metadata_rejects_capability_not_object():
    from app.services.event_definition_registry import InvalidStageMetadataError, validate_stage_metadata

    schema = {"properties": {"stage": {"enum": ["publish"]}}}
    with pytest.raises(InvalidStageMetadataError):
        validate_stage_metadata(schema, {
            "publish": {"role": "Agent", "action": "발행", "capability": "publish"},
        })


def test_validate_stage_metadata_rejects_empty_kind():
    from app.services.event_definition_registry import InvalidStageMetadataError, validate_stage_metadata

    schema = {"properties": {"stage": {"enum": ["publish"]}}}
    with pytest.raises(InvalidStageMetadataError):
        validate_stage_metadata(schema, {
            "publish": {"role": "Agent", "action": "발행", "capability": {"kind": ""}},
        })


def test_validate_stage_metadata_rejects_empty_connector_key():
    from app.services.event_definition_registry import InvalidStageMetadataError, validate_stage_metadata

    schema = {"properties": {"stage": {"enum": ["publish"]}}}
    with pytest.raises(InvalidStageMetadataError):
        validate_stage_metadata(schema, {
            "publish": {
                "role": "Agent", "action": "발행",
                "capability": {"kind": "publish", "connector_key": ""},
            },
        })


# ─── 실행 축(realdb) — apply 시 warnings[] ─────────────────────────────────────


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


async def _seed_org_project(session, *, slug):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org3317b", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_definition(session, *, org_id, key, stage_metadata):
    """key는 "org.{slug}.*" 네임스페이스 — CHECK 제약(ck_event_definitions_key_namespace)이
    이 형태는 org_id NOT NULL을 요구한다(model.py 참조, preset.*만 org_id NULL 허용)."""
    from app.models.event_definition import EventDefinition

    schema = {
        "type": "object", "additionalProperties": False,
        "required": ["stage", "work_item_type", "work_item_id"],
        "properties": {
            "stage": {"type": "string", "enum": list(stage_metadata.keys())},
            "work_item_type": {"type": "string"}, "work_item_id": {"type": "string", "format": "uuid"},
        },
    }
    routing = {
        "escalation": {"kind": "server_derived", "target": "none"},
        "broadcast": {"kind": "server_derived", "target": "none"},
    }
    d = EventDefinition(
        id=uuid.uuid4(), key=key, org_id=org_id, payload_schema=schema, routing=routing,
        stage_metadata=stage_metadata,
    )
    session.add(d)
    await session.commit()
    return d


# 미르코군 PR#33(plugins/sprintable-agent-plugins, head e30be0940) 실 wire 픽스처 —
# threads.kinds=["publish","measure"]·stibee.kinds=["publish"](페드루 제공, 2026-09-02).
_THREADS_FIXTURE = _load_fixture("threads")
_STIBEE_FIXTURE = _load_fixture("stibee")


async def _register_connector_from_fixture(session, org_id, fixture, *, org_config=None):
    from app.services.connector_registry import set_org_connector_schema, set_org_connector_config

    await set_org_connector_schema(
        session, org_id=org_id, connector_key=fixture["connector_key"], version=fixture["version"],
        channel=fixture["channel"], fields=fixture["fields"], requires_env=fixture["requires_env"],
        kinds=fixture.get("kinds"), created_by=None,
    )
    if org_config:
        await set_org_connector_config(
            session, org_id=org_id, connector_key=fixture["connector_key"], config=org_config,
        )


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_no_capability_declared_yields_no_warnings():
    """⭐회귀 0 — capability 선언 없는 기존 정의(#3288류)는 apply해도 warnings=[]."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="b3317a")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")
            definition = await _seed_definition(
                s, org_id=org_id, key="org.b3317a.recipe_nocap",
                stage_metadata={"step_1": {"role": "Worker", "action": "do"}},
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"step_1": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.warnings == []
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_connector_key_specified_unregistered_warns():
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="b3317b")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")
            definition = await _seed_definition(
                s, org_id=org_id, key="org.b3317b.recipe_cap",
                stage_metadata={
                    "publish": {
                        "role": "Agent", "action": "발행",
                        "capability": {"kind": "publish", "connector_key": "stibee"},
                    },
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"publish": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.ok  # apply 자체는 안 막힘.
            assert len(resp.warnings) == 1
            assert "stibee" in resp.warnings[0]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_connector_key_specified_missing_required_config_warns():
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="b3317c")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")
            await _register_connector_from_fixture(s, org_id, _STIBEE_FIXTURE)  # org_config 미충족

            definition = await _seed_definition(
                s, org_id=org_id, key="org.b3317c.recipe_cap",
                stage_metadata={
                    "publish": {
                        "role": "Agent", "action": "발행",
                        "capability": {"kind": "publish", "connector_key": "stibee"},
                    },
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"publish": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert len(resp.warnings) == 1
            for required_field in ("create.senderEmail", "create.senderName", "create.listId"):
                assert required_field in resp.warnings[0]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_connector_key_specified_fully_configured_yields_no_warning():
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="b3317d")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")
            await _register_connector_from_fixture(
                s, org_id, _STIBEE_FIXTURE,
                org_config={
                    "create.senderEmail": "hello@example.com", "create.senderName": "Org",
                    "create.listId": 1,
                },
            )

            definition = await _seed_definition(
                s, org_id=org_id, key="org.b3317d.recipe_cap",
                stage_metadata={
                    "publish": {
                        "role": "Agent", "action": "발행",
                        "capability": {"kind": "publish", "connector_key": "stibee"},
                    },
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"publish": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.warnings == []
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_kind_only_no_matching_connector_warns():
    """connector_key 미지정 — 이 org에 kind='collect'를 지원하는 커넥터가(threads/stibee
    둘 다 publish[+measure]뿐, collect는 없음) 하나도 없으면 경고."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="b3317e")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")
            # threads(publish·measure)·stibee(publish) 둘 다 등록 — 'collect'는 아무도 지원 안 함.
            await _register_connector_from_fixture(s, org_id, _THREADS_FIXTURE)
            await _register_connector_from_fixture(s, org_id, _STIBEE_FIXTURE)

            definition = await _seed_definition(
                s, org_id=org_id, key="org.b3317e.recipe_cap",
                stage_metadata={
                    "monitor": {"role": "Agent", "action": "수집", "capability": {"kind": "collect"}},
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"monitor": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert len(resp.warnings) == 1
            assert "collect" in resp.warnings[0]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_kind_only_one_matching_configured_connector_yields_no_warning():
    """connector_key 미지정 — kind='publish'가 맞는 커넥터가 여러 개 중 하나만 충족돼도
    통과(느슨 매칭 — 어느 것이든 되면 됨, PO 확定). threads는 필수 org_config 필드가
    아예 없어(text만 source=content) 미설정 상태로도 이미 충족·stibee는 미충족(설정 0건) —
    threads 하나만으로 통과해야 한다."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="b3317f")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")
            await _register_connector_from_fixture(s, org_id, _THREADS_FIXTURE)  # 필수 org_config 0개 — 충족
            await _register_connector_from_fixture(s, org_id, _STIBEE_FIXTURE)  # 미충족

            definition = await _seed_definition(
                s, org_id=org_id, key="org.b3317f.recipe_cap",
                stage_metadata={
                    "publish": {"role": "Agent", "action": "발행", "capability": {"kind": "publish"}},
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"publish": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.warnings == []
    finally:
        await engine.dispose()
