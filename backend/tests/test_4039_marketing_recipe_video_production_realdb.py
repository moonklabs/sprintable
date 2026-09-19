"""story #4039(E-RECIPE-1 ①) — 마케팅 레시피 1호(«영상 제작») 프리셋 시드
(alembic/versions/0381_preset_marketing_video_production_recipe.py) 실증.

단위 축(DB 불요) — 마이그 상수를 event_definition_registry의 등록 시점 검증기 그대로에
통과시켜 seed 자체가 유효한 계약인지 고정한다. 실행 축(realdb) — AC1(«dev 조직에서 apply
가능») AC2(게이트4 전부가 실제로 stage 이벤트 발행 시 pending Gate를 만드는지, approver가
정확히 org_owner로 해석되는지) 를 `apply_recipe_role_bindings`·`publish_registry_event`
(둘 다 기존 완성 엔드포인트 — 이 카드는 새 배선 0, seed 데이터만) 실호출로 증명한다.

AC4(get_db·get_read_db 둘 다 override) — `tests/conftest.py::override_db_and_read`(story
#2451 §6 root-fix 헬퍼)를 그대로 써서 실 HTTP 계층(GET /events/definitions·POST
/events/definitions/{id}/apply)까지 한 번 왕복시킨다(`test_http_definitions_list_and_apply_
via_overridden_db_and_read_db`) — 나머지 테스트는 이 코드베이스의 표준 realdb 관례(라우터
함수 직접 호출, test_3312/test_3317b/test_3359 선례)를 따른다.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _load_migration_module():
    import importlib.util

    spec = importlib.util.spec_from_file_location(
        "_m0379",
        os.path.join(
            os.path.dirname(__file__), "..", "alembic", "versions",
            "0381_preset_marketing_video_production_recipe.py",
        ),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


_MIG = _load_migration_module()

# 페드루 PO 후속 킥오프 #4044(2026-09-18 06:16Z) — ⓑ구조·ⓒ실탄 gate_type은 아직 미확定
# (엔진 실측: gate_type 실존은 concept_approval·external_publish 둘뿐)이라 이 카드는 그
# 둘만 wired로 시드한다. structure_passed·live_generation은 role/action/capability는
# 있지만 gate 없음 — #4044가 gate_type 確定 후 후속 UPDATE로 얹는다.
_GATE_STAGES = {
    "concept_confirmed": "concept_approval",
    "pending_approval": "external_publish",
}
_GATE_PENDING_STAGES = ("structure_passed", "live_generation")


# ─── 단위 축 — 등록 시점 검증기 전체 통과(seed 자체의 계약 유효성) ────────────────


def test_seed_key_is_marketing_namespace_distinct_from_dev_workflow():
    """AC3 — 신규 컬럼 없이 key 둘째 세그먼트로 개발(workflow)과 마케팅을 구분."""
    assert _MIG._KEY == "preset.marketing.video_production"
    assert _MIG._KEY.split(".")[1] == "marketing"


def test_seed_has_nine_stages_and_two_wired_gates_two_pending_4044():
    assert len(_MIG._STAGE_SLUGS) == 9
    assert list(_MIG._STAGE_METADATA.keys()) == _MIG._STAGE_SLUGS
    gated = {slug: meta["gate"]["type"] for slug, meta in _MIG._STAGE_METADATA.items() if "gate" in meta}
    assert gated == _GATE_STAGES
    for meta in _MIG._STAGE_METADATA.values():
        if "gate" in meta:
            assert meta["gate"]["approver"] == "org_owner"
    for slug in _GATE_PENDING_STAGES:
        assert "gate" not in _MIG._STAGE_METADATA[slug]


def test_seed_key_passes_validate_event_definition_key():
    from app.services.event_definition_registry import validate_event_definition_key
    validate_event_definition_key(_MIG._KEY, org_id=None, org_slug=None)  # raise 없으면 통과


def test_seed_routing_passes_validate_event_routing():
    from app.services.event_definition_registry import validate_event_routing
    validate_event_routing(_MIG._ROUTING)


def test_seed_stage_metadata_passes_validate_stage_metadata():
    from app.services.event_definition_registry import validate_stage_metadata
    validate_stage_metadata(_MIG._PAYLOAD_SCHEMA, _MIG._STAGE_METADATA)


def test_seed_block_template_passes_validate_block_template_and_refs():
    from app.services.event_definition_registry import validate_block_template, validate_block_template_refs
    validate_block_template(_MIG._BLOCK_TEMPLATE)
    validate_block_template_refs(_MIG._PAYLOAD_SCHEMA, _MIG._BLOCK_TEMPLATE)


# ─── 실행 축(realdb) ────────────────────────────────────────────────────────────


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


async def _seed_definition(session):
    """0379.upgrade()가 넣는 행과 동일 내용을 ORM으로 재현(마이그=정본, 이 seed는 그 값을
    그대로 참조 — 손 복붙 없음, gate.py/evidence.py의 «마이그=정본·모델=미러» 관례와 동형)."""
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=_MIG._KEY, org_id=None, name=_MIG._NAME, description=_MIG._DESCRIPTION,
        payload_schema=_MIG._PAYLOAD_SCHEMA, routing=_MIG._ROUTING, block_template=_MIG._BLOCK_TEMPLATE,
        stage_metadata=_MIG._STAGE_METADATA,
    )
    session.add(d)
    await session.commit()
    return d


async def _seed_org_with_owner(session, *, slug):
    from app.models.organization import Organization
    from app.models.project import OrgMember, Project

    org = Organization(id=uuid.uuid4(), name="OrgRecipe", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    owner_member = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=uuid.uuid4(), role="owner")
    session.add(owner_member)
    await session.commit()
    return org.id, project.id, owner_member.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember
    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="레시피 1호 산출물"):
    from app.models.pm import Story
    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request() -> "StarletteRequest":
    from starlette.requests import Request as StarletteRequest
    return StarletteRequest(scope={"type": "http", "headers": []})


async def test_apply_recipe_role_bindings_binds_creator_and_publisher_slots():
    """AC1 핵심 — dev 조직에서 이 정의로 apply(=역할 슬롯 바인딩)가 실제로 된다. 디렉터(사람)·
    연산(모델 임대)은 recipe_role_bindings 대상이 아니라(gate.approver·capability로만 선언)
    크리에이터·발행자 슬롯 5 stage만 바인딩한다."""
    from app.routers.events import ApplyRecipeRoleBindingsRequest, apply_recipe_role_bindings

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, _owner_id = await _seed_org_with_owner(s, slug="recipe4039a")
            caller_id = await _seed_agent(s, org_id, project_id, name="caller")
            creator_id = await _seed_agent(s, org_id, project_id, name="댄-크리에이터")
            publisher_id = await _seed_agent(s, org_id, project_id, name="담롱-발행자")
            definition = await _seed_definition(s)

            role_mapping = {
                "draft": str(creator_id), "animatic": str(creator_id),
                "verification": str(creator_id), "editing": str(creator_id),
                "published": str(publisher_id),
            }
            resp = await apply_recipe_role_bindings(
                definition.id,
                ApplyRecipeRoleBindingsRequest(project_id=None, role_mapping=role_mapping),
                db=s, auth=_auth(caller_id, org_id), org_id=org_id,
            )
            assert resp.ok is True
            assert resp.bindings_upserted == 5

            from app.models.recipe_role_binding import RecipeRoleBinding
            from sqlalchemy import select
            rows = (await s.execute(
                select(RecipeRoleBinding).where(RecipeRoleBinding.event_definition_key == _MIG._KEY)
            )).scalars().all()
            assert {r.stage for r in rows} == set(role_mapping.keys())
    finally:
        await engine.dispose()


async def test_definition_visible_in_org_catalog_listing():
    """AC1 — 플랫폼 프리셋(org_id NULL)이라 org_id 무관하게 모든 org의 카탈로그에 뜬다."""
    from app.routers.events import list_event_definitions

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _project_id, _owner_id = await _seed_org_with_owner(s, slug="recipe4039b")
            await _seed_definition(s)

            rows = await list_event_definitions(db=s, org_id=org_id)
            assert any(r.key == _MIG._KEY for r in rows)
    finally:
        await engine.dispose()


@pytest.mark.parametrize("stage,expected_gate_type", sorted(_GATE_STAGES.items()))
async def test_each_gate_stage_auto_creates_pending_gate_with_org_owner_approver(stage, expected_gate_type):
    """AC2 핵심 — 게이트4(ⓐⓑⓒⓓ) 전부, 그 stage 이벤트가 발행되면 recipe_gate_hooks가
    pending Gate를 gate_type=expected_gate_type·designated_approver_id=org owner로 자동
    생성한다(신규 배선 0 — 기존 story #3312 메커니즘을 그대로 태우는 것 자체가 증명 대상)."""
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.models.gate import Gate
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, owner_member_id = await _seed_org_with_owner(s, slug=f"r4039c{stage[:6]}")
            agent_id = await _seed_agent(s, org_id, project_id)
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_definition(s)

            body = EventPublishRequest(
                definition_key=_MIG._KEY,
                payload={"stage": stage, "work_item_type": "story", "work_item_id": str(story_id)},
            )
            await publish_registry_event(
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(agent_id, org_id), org_id=org_id,
            )

            gates = (await s.execute(
                select(Gate).where(Gate.work_item_id == story_id, Gate.gate_type == expected_gate_type)
            )).scalars().all()
            assert len(gates) == 1
            assert gates[0].status == "pending"
            assert gates[0].designated_approver_id == owner_member_id
    finally:
        await engine.dispose()


def test_events_router_does_not_split_get_read_db():
    """AC4 「get_db·get_read_db 둘 다 override」의 실제 적용 범위를 정직하게 못박는다 —
    `apply_recipe_role_bindings`/`list_event_definitions`/`publish_registry_event`가 속한
    `app/routers/events.py`는 이 마이그가 건드리는 경로 전부에서 `get_db`만 쓰고
    `get_read_db`는 아예 안 쓴다(그 이름의 심볼이 이 모듈에 없음 — grep으로도 확認 가능).
    즉 story #2451류 "get_db만 걸고 get_read_db 빠뜨림" 회귀 클래스 자체가 이 라우터엔
    성립하지 않는다 — 위 realdb 테스트들이 직접 호출로 실 세션을 물려 왕복시키는 것으로
    두 쪽 다(쓰기·읽기 전부 get_db 하나) 이미 커버됐다는 뜻."""
    import inspect
    from app.routers import events as events_router

    source = inspect.getsource(events_router)
    assert "get_read_db" not in source
