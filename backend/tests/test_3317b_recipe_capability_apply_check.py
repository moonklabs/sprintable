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
            # story #4108 CHANGES(페드루 PO 리뷰, 2026-09-21) — missing(list[str])이 파이썬
            # list repr(대괄호·따옴표)로 안 새는지 고정 — join된 사람말 목록이어야 한다.
            assert "[" not in resp.warnings[0]
            assert "'" not in resp.warnings[0]
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


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_agent_tool_hint_kind_yields_no_warning_even_with_zero_connectors():
    """story #4104(페드루 PO 라이브 실측, 2026-09-21) — attach_video(#4088 2/2 자기설명
    멘션 힌트, 에이전트가 자기 도구로 처리)는 org 커넥터로 채워지는 kind가 아니다.
    커넥터를 org에 하나도 등록 안 한 채로 apply해도(위 test_apply_kind_only_no_matching_
    connector_warns와 대조적으로) 경고 0건이어야 한다 — kind가 다르면 판정도 달라야
    한다는 것을 같은 «커넥터 0건» 조건으로 대조한다."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="b4104a")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")
            # 커넥터 0건 등록 — attach_video는 애초에 커넥터를 안 보므로 무관해야 한다.

            definition = await _seed_definition(
                s, org_id=org_id, key="org.b4104a.recipe_cap",
                stage_metadata={
                    "editing": {"role": "Creator", "action": "편집", "capability": {"kind": "attach_video"}},
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"editing": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.warnings == []
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_warning_translates_registered_role_to_korean_label():
    """story #4108 design CHANGES(유나·페드루 PO, 2026-09-21) — role="Publisher"는
    FE stage-role.ts 정본 17종에 있어 한글 라벨 "발행자 단계"로 뜬다(원어 "Publisher"도
    원래 stage 키도 문장에 안 남는다) — 준비 경고 문장에 영어 role enum이 그대로
    새는(story #4460류) 재발을 막는다."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="b4108c")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")
            definition = await _seed_definition(
                s, org_id=org_id, key="org.b4108c.recipe_cap",
                stage_metadata={
                    "published": {
                        "role": "Publisher", "action": "발행",
                        "capability": {"kind": "publish"},
                    },
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"published": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert len(resp.warnings) == 1
            assert "발행자 단계" in resp.warnings[0]
            assert "Publisher" not in resp.warnings[0]
            assert "published" not in resp.warnings[0]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_warning_uses_stage_role_label_not_raw_stage_key():
    """story #4108(페드루 PO 確定, 2026-09-21) — 미등재(조직 커스텀) role은 FE
    stageRoleLabel과 동형 원칙으로 raw pass-through — 이미 사람말인 커스텀 role
    "발행 담당자"는 그대로 "발행 담당자 단계"로 뜬다. 원래 stage 키("publish_video")도
    파이썬 repr 토큰(`stage='...'`)도 문장에 안 남는다."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="b4108a")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")
            definition = await _seed_definition(
                s, org_id=org_id, key="org.b4108a.recipe_cap",
                stage_metadata={
                    "publish_video": {
                        "role": "발행 담당자", "action": "발행",
                        "capability": {"kind": "publish"},
                    },
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"publish_video": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert len(resp.warnings) == 1
            assert "발행 담당자 단계" in resp.warnings[0]
            assert "publish_video" not in resp.warnings[0]
            assert "='" not in resp.warnings[0]
            assert "stage=" not in resp.warnings[0]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_apply_warning_falls_back_to_stage_key_when_role_missing():
    """story #4108 — role이 없는 stage_metadata(등록 API는 항상 role을 요구하지만,
    이 realdb 테스트는 _seed_definition으로 그 검증을 우회해 방어적 폴백 경로를
    직접 겨냥한다)는 라벨 없이 stage 키 그대로("editing_stage") 노출한다 — "단계"
    접미사도 안 붙는다(있는 라벨을 사람말로 쓰는 것과 «지어내는» 것은 다르다)."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s, slug="b4108b")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            agent_id = await _seed_agent(s, org_id, project_id, name="worker")
            definition = await _seed_definition(
                s, org_id=org_id, key="org.b4108b.recipe_cap",
                stage_metadata={
                    "editing_stage": {"capability": {"kind": "publish"}},
                },
            )
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping={"editing_stage": str(agent_id)}),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert len(resp.warnings) == 1
            assert "editing_stage" in resp.warnings[0]
            assert "editing_stage 단계" not in resp.warnings[0]
    finally:
        await engine.dispose()


def test_stage_role_label_keys_match_fe_stage_role_ts_pin():
    """story #4108 design CHANGES(페드루 PO 지시, 2026-09-21) — 카디르 QA 대칭 테스트
    관례(FE `RECIPE_STAGE_LABEL_SLUGS`/`STAGE_ROLE_PRESET_VALUES` export와 동형)를 BE
    쪽에 적용. FE 정본은 `apps/web/src/lib/stage-role.ts`의 `STAGE_ROLE_PRESET_VALUES`
    (story #3773, 유나 定) — 이 파일을 읽지 않고(교차언어 파일 읽기 대신 상수 목록 고정
    pin) 그 17종을 여기 하드코딩해 BE `_STAGE_ROLE_LABEL_KEYS`와 대조한다. 어느 한쪽만
    새 role을 추가하면(등재≠배선 함정) 이 테스트가 RED — FE에 새 role이 추가되면 이
    목록도, i18n_catalog.py의 `events.stage_role.<Role>` 키도 함께 늘릴 것."""
    from app.routers.events import _STAGE_ROLE_LABEL_KEYS
    from app.services.i18n_catalog import _CATALOG

    # FE apps/web/src/lib/stage-role.ts::STAGE_ROLE_PRESET_VALUES 고정 pin(2026-09-21 기준).
    fe_stage_role_preset_values = frozenset({
        "Agent", "Any", "Approver", "Compute", "Creator", "Dev", "Director", "Executor",
        "Human", "Lead", "Maker", "Member", "PO", "Publisher", "QA", "Reviewer", "Worker",
    })
    assert _STAGE_ROLE_LABEL_KEYS == fe_stage_role_preset_values
    # BE 카탈로그에도 그 17종 전부가 events.stage_role.<Role> 키로 등재돼 있는지(등재만
    # 되고 배선 안 되는 것도 막는다 — 위 assert가 집합만 맞추고 실제 카탈로그 키 존재는
    # 안 볼 수 있어 이중으로 확認).
    for role in fe_stage_role_preset_values:
        assert f"events.stage_role.{role}" in _CATALOG
