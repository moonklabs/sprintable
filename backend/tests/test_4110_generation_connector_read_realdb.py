"""story #4110([E-RECIPE-1] 연산 슬롯 2/2 BE) — #4109 PO 결정(그라운딩 doc 733459ac
「PO 결정」절, 2026-09-21)의 구현. 바인딩 crew 에이전트가 자기 레시피 적용의
generation_connector-target stage에 바인딩된 org 연산 커넥터 config·자격을 읽는 REST
(`GET /api/v2/events/work-items/{type}/{id}/generation-connector`) + 리졸버
`_resolve_recipe_role_binding`의 generation_connector-target stage crew 폴백.

세팅 헬퍼는 test_4082_recipe_progress_status.py(_publish_registry_event_core 발행
패턴)·test_m2_recipe_role_binding_routing_realdb.py(publish_registry_event + resolver
crew 실측 패턴)·test_4101_generation_connector_realdb.py(커넥터 crypto 시크릿 격리·
커넥터 seed)를 그대로 재사용(발명 0)."""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]

_DEFINITION_KEY = "org.e4110.recipe_cap"

# 2단계 최소 레시피 — draft(agent-target, 기본값)로 "시작"을 표시한 뒤 live_generation
# (generation_connector-target)으로 진행. #4101이 실제로 patch한 video_production
# preset과 동형(단계 수만 축소 — 이 카드가 겨냥하는 판정 로직엔 단계 수가 무관).
_PAYLOAD_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["draft", "live_generation"]},
        "work_item_type": {"type": "string"}, "work_item_id": {"type": "string", "format": "uuid"},
    },
}
_ROUTING = {
    "broadcast": {"kind": "recipe_role_binding"},
    "escalation": {"kind": "server_derived", "target": "none"},
}
_STAGE_METADATA = {
    "draft": {"role": "Creator", "action": "초안 작성", "capability": {"kind": "attach_video"}},
    "live_generation": {
        "role": "Compute", "action": "생성 실행",
        "capability": {"kind": "generate", "target": "generation_connector"},
    },
}


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


async def _seed_org_project(session, *, slug="e4110"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org4110", slug=slug)
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


async def _seed_human(session, org_id, project_id, *, name="human"):
    from app.models.team import TeamMember

    m = TeamMember(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="human", name=name, is_active=True)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, title="S"):
    from app.models.pm import Story

    story = Story(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title=title)
    session.add(story)
    await session.commit()
    return story.id


async def _seed_definition(session, *, org_id, key=_DEFINITION_KEY):
    from app.models.event_definition import EventDefinition

    d = EventDefinition(
        id=uuid.uuid4(), key=key, org_id=org_id, name="테스트 연산 레시피",
        payload_schema=_PAYLOAD_SCHEMA, routing=_ROUTING, stage_metadata=_STAGE_METADATA,
        enabled=True, version=1,
    )
    session.add(d)
    await session.commit()
    return d


async def _seed_agent_binding(session, *, org_id, project_id, stage, agent_id, key=_DEFINITION_KEY):
    from app.models.recipe_role_binding import RecipeRoleBinding

    session.add(RecipeRoleBinding(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        event_definition_key=key, stage=stage, agent_member_id=agent_id,
    ))
    await session.commit()


async def _seed_connector_binding(session, *, org_id, project_id, stage, connector_id, key=_DEFINITION_KEY):
    from app.models.recipe_role_binding import RecipeRoleBinding

    session.add(RecipeRoleBinding(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        event_definition_key=key, stage=stage, generation_connector_id=connector_id,
    ))
    await session.commit()


async def _seed_generation_connector(session, org_id, *, status="active", label="v1"):
    from app.models.org_generation_connector import OrgGenerationConnector
    from app.services.generation_connector_credential_crypto import encrypt_generation_connector_credential

    c = OrgGenerationConnector(
        id=uuid.uuid4(), org_id=org_id, provider_key="vertex_gemini", label=label,
        model_config_json={"image": "gemini-2.5-flash-image"},
        encrypted_credentials=encrypt_generation_connector_credential("super-secret-api-key"),
        status=status,
    )
    session.add(c)
    await session.commit()
    return c.id


def _auth(member_id, org_id):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(member_id), email=None,
        claims={"app_metadata": {"api_key_id": "test-agent"}}, org_id=str(org_id),
    )


async def _publish_stage(session, *, org_id, definition_key=_DEFINITION_KEY, story_id, stage, requester_id):
    from app.routers.events import _publish_registry_event_core

    return await _publish_registry_event_core(
        session, org_id, _auth(requester_id, org_id), definition_key,
        {"work_item_type": "story", "work_item_id": str(story_id), "stage": stage},
        BackgroundTasks(),
    )


async def _call_endpoint(session, *, org_id, work_item_id, caller_id, work_item_type="story"):
    from app.routers.events import get_my_generation_connector

    return await get_my_generation_connector(
        work_item_type, work_item_id, db=session, auth=_auth(caller_id, org_id), org_id=org_id,
    )


async def _advance_to_live_generation(session, *, org_id, project_id, story_id, drafter_id):
    """draft(첫 단계)로 "시작" 표시 후 live_generation으로 진행 — get_recipe_start_
    candidates·이 카드의 엔드포인트 둘 다 same SSOT(첫 단계 발행=started)를 쓰므로
    draft를 건너뛰면 "시작 안 됨"으로 판정돼 stage-mismatch 403과 구별이 안 된다."""
    await _publish_stage(session, org_id=org_id, story_id=story_id, stage="draft", requester_id=drafter_id)
    await _publish_stage(session, org_id=org_id, story_id=story_id, stage="live_generation", requester_id=drafter_id)


# ─── 성공 경로 ──────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_crew_agent_reads_config_and_plaintext_credentials():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            story_id = await _seed_story(s, org_id, project_id)
            connector_id = await _seed_generation_connector(s, org_id)
            await _seed_agent_binding(s, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id)
            await _seed_connector_binding(
                s, org_id=org_id, project_id=project_id, stage="live_generation", connector_id=connector_id,
            )
            await _advance_to_live_generation(s, org_id=org_id, project_id=project_id, story_id=story_id, drafter_id=drafter_id)

            resp = await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=drafter_id)

            assert resp.provider_key == "vertex_gemini"
            assert resp.label == "v1"
            assert resp.model_config_json == {"image": "gemini-2.5-flash-image"}
            assert resp.credentials == "super-secret-api-key"
            # story #4140 — 제품 리전 정책값(crew 재량 0). 이 seed의 model_config_json엔
            # location 키가 없다(기존 커넥터 동형) → 해소값은 "global"이어야 한다.
            assert resp.location == "global"
    finally:
        await engine.dispose()


# ─── 거부 5경로(AC2) ────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_human_caller_403():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            human_id = await _seed_human(s, org_id, project_id, name="human-caller")
            story_id = await _seed_story(s, org_id, project_id)
            connector_id = await _seed_generation_connector(s, org_id)
            await _seed_agent_binding(s, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id)
            await _seed_connector_binding(
                s, org_id=org_id, project_id=project_id, stage="live_generation", connector_id=connector_id,
            )
            await _advance_to_live_generation(s, org_id=org_id, project_id=project_id, story_id=story_id, drafter_id=drafter_id)

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=human_id)
            assert exc_info.value.status_code == 403
            assert exc_info.value.detail == {"code": "GENERATION_CONNECTOR_READ_AGENT_ONLY"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_outside_crew_403():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            outsider_id = await _seed_agent(s, org_id, project_id, name="outsider")
            story_id = await _seed_story(s, org_id, project_id)
            connector_id = await _seed_generation_connector(s, org_id)
            await _seed_agent_binding(s, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id)
            await _seed_connector_binding(
                s, org_id=org_id, project_id=project_id, stage="live_generation", connector_id=connector_id,
            )
            await _advance_to_live_generation(s, org_id=org_id, project_id=project_id, story_id=story_id, drafter_id=drafter_id)

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=outsider_id)
            assert exc_info.value.status_code == 403
            assert exc_info.value.detail == {"code": "GENERATION_CONNECTOR_CREW_ONLY"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_outside_crew_with_revoked_connector_still_403_not_409():
    """story #4110 CHANGES-1(페드루 PO 리뷰, 2026-09-21) — crew 판정이 바인딩·커넥터
    조회보다 먼저 돈다: 커넥터가 revoked라도 crew 밖 에이전트는 409가 아니라 403을
    받는다(그 자격 정보 자체를 crew 밖에겐 안 준다 — 순서가 안 지켜지면 이 테스트가
    409로 RED)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            outsider_id = await _seed_agent(s, org_id, project_id, name="outsider")
            story_id = await _seed_story(s, org_id, project_id)
            connector_id = await _seed_generation_connector(s, org_id, status="revoked")
            await _seed_agent_binding(s, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id)
            await _seed_connector_binding(
                s, org_id=org_id, project_id=project_id, stage="live_generation", connector_id=connector_id,
            )
            await _advance_to_live_generation(s, org_id=org_id, project_id=project_id, story_id=story_id, drafter_id=drafter_id)

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=outsider_id)
            assert exc_info.value.status_code == 403
            assert exc_info.value.detail == {"code": "GENERATION_CONNECTOR_CREW_ONLY"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_zero_binding_agent_gets_crew_only_not_stage_mismatch():
    """story #4124(PO 실측, 2026-09-21) — 이 project/org 어느 적용에도 전혀 안 묶인
    (바인딩 0건) 에이전트가 아직 live_generation에 도달 안 한 스토리를 조회하면,
    stage-매칭 루프가 먼저 돌아 STAGE_MISMATCH를 주던 게 구멍이었다. 넓은 crew
    사전 관문이 stage 매칭보다 먼저 막아야 한다(그 다음 검사 0)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            outsider_id = await _seed_agent(s, org_id, project_id, name="outsider")
            story_id = await _seed_story(s, org_id, project_id)
            connector_id = await _seed_generation_connector(s, org_id)
            await _seed_agent_binding(s, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id)
            await _seed_connector_binding(
                s, org_id=org_id, project_id=project_id, stage="live_generation", connector_id=connector_id,
            )
            await _publish_stage(s, org_id=org_id, story_id=story_id, stage="draft", requester_id=drafter_id)

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=outsider_id)
            assert exc_info.value.status_code == 403
            assert exc_info.value.detail == {"code": "GENERATION_CONNECTOR_CREW_ONLY"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_zero_binding_agent_gets_crew_only_not_binding_not_found():
    """story #4124 — 바인딩 0건 에이전트가 live_generation까지 진행됐지만 그 stage에
    커넥터 바인딩 자체가 없는 스토리를 조회해도, 그 사실(BINDING_NOT_FOUND)을 알기
    前에 CREW_ONLY로 먼저 막혀야 한다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            outsider_id = await _seed_agent(s, org_id, project_id, name="outsider")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_agent_binding(s, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id)
            # live_generation 바인딩 자체를 만들지 않음.
            await _advance_to_live_generation(s, org_id=org_id, project_id=project_id, story_id=story_id, drafter_id=drafter_id)

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=outsider_id)
            assert exc_info.value.status_code == 403
            assert exc_info.value.detail == {"code": "GENERATION_CONNECTOR_CREW_ONLY"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_no_applied_recipes_at_all_gets_crew_only():
    """story #4124 경계 — 이 project/org에 적용된 레시피 자체가 0건(binding_rows
    빈 집합)이면 넓은 crew 집합도 빈 집합이라, 어느 에이전트든 CREW_ONLY(빈 집합
    분기 `else: broad_crew_ids = set()`가 안 죽는지 직접 고정)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            # 정의도 바인딩도 아예 만들지 않음.
            outsider_id = await _seed_agent(s, org_id, project_id, name="outsider")
            story_id = await _seed_story(s, org_id, project_id)

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=outsider_id)
            assert exc_info.value.status_code == 403
            assert exc_info.value.detail == {"code": "GENERATION_CONNECTOR_CREW_ONLY"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_stage_mismatch_403_when_not_yet_at_generation_connector_stage():
    """draft까지만 발행(시작은 됐지만 아직 live_generation이 아님) — «지금 이 도구를
    쓸 차례가 아니다»."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            story_id = await _seed_story(s, org_id, project_id)
            connector_id = await _seed_generation_connector(s, org_id)
            await _seed_agent_binding(s, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id)
            await _seed_connector_binding(
                s, org_id=org_id, project_id=project_id, stage="live_generation", connector_id=connector_id,
            )
            await _publish_stage(s, org_id=org_id, story_id=story_id, stage="draft", requester_id=drafter_id)

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=drafter_id)
            assert exc_info.value.status_code == 403
            assert exc_info.value.detail == {"code": "GENERATION_CONNECTOR_STAGE_MISMATCH"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_binding_not_found_404_when_stage_reached_but_unbound():
    """live_generation까지 진행됐지만 그 stage에 커넥터 바인딩 자체가 없음."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_agent_binding(s, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id)
            # live_generation 바인딩 자체를 만들지 않음.
            await _advance_to_live_generation(s, org_id=org_id, project_id=project_id, story_id=story_id, drafter_id=drafter_id)

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=drafter_id)
            assert exc_info.value.status_code == 404
            assert exc_info.value.detail == {"code": "GENERATION_CONNECTOR_BINDING_NOT_FOUND"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_revoked_connector_409():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            story_id = await _seed_story(s, org_id, project_id)
            connector_id = await _seed_generation_connector(s, org_id, status="revoked")
            await _seed_agent_binding(s, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id)
            await _seed_connector_binding(
                s, org_id=org_id, project_id=project_id, stage="live_generation", connector_id=connector_id,
            )
            await _advance_to_live_generation(s, org_id=org_id, project_id=project_id, story_id=story_id, drafter_id=drafter_id)

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=drafter_id)
            assert exc_info.value.status_code == 409
            assert exc_info.value.detail == {"code": "GENERATION_CONNECTOR_REVOKED"}
    finally:
        await engine.dispose()


# ─── 감사 로그(자격값 0) ─────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_audit_log_line_has_no_credential_string(caplog):
    import logging

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            story_id = await _seed_story(s, org_id, project_id)
            connector_id = await _seed_generation_connector(s, org_id)
            await _seed_agent_binding(s, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id)
            await _seed_connector_binding(
                s, org_id=org_id, project_id=project_id, stage="live_generation", connector_id=connector_id,
            )
            await _advance_to_live_generation(s, org_id=org_id, project_id=project_id, story_id=story_id, drafter_id=drafter_id)

            with caplog.at_level(logging.INFO, logger="app.routers.events"):
                resp = await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=drafter_id)

            audit_lines = [r.getMessage() for r in caplog.records if "generation_connector_read" in r.getMessage()]
            assert len(audit_lines) == 1
            assert resp.credentials not in audit_lines[0]
            assert str(connector_id) in audit_lines[0]
            assert str(drafter_id) in audit_lines[0]
    finally:
        await engine.dispose()


# ─── 리졸버 crew 폴백(AC3) ──────────────────────────────────────────────────


@pytest.mark.anyio
async def test_resolver_fallback_returns_crew_for_generation_connector_stage():
    """generation_connector-target stage(live_generation)의 broadcast 수신자 =
    같은 적용(org·project·event_definition_key)의 agent_member_id 집합(crew) —
    이 stage 자체엔 agent_member_id가 없어도(XOR) 리졸버가 폴백한다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            story_id = await _seed_story(s, org_id, project_id)
            connector_id = await _seed_generation_connector(s, org_id)
            await _seed_agent_binding(s, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id)
            await _seed_connector_binding(
                s, org_id=org_id, project_id=project_id, stage="live_generation", connector_id=connector_id,
            )
            await _publish_stage(s, org_id=org_id, story_id=story_id, stage="draft", requester_id=drafter_id)

            resp = await _publish_stage(
                s, org_id=org_id, story_id=story_id, stage="live_generation", requester_id=drafter_id,
            )

            assert resp["broadcast_member_ids"] == [str(drafter_id)]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resolver_fallback_returns_multi_member_crew():
    """crew가 2명(다른 stage에 각각 바인딩)이면 둘 다 수신자."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id, key="org.e4110.two_agent")
            second_stage_metadata_key = "org.e4110.two_agent"
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            reviewer_id = await _seed_agent(s, org_id, project_id, name="reviewer")
            story_id = await _seed_story(s, org_id, project_id)
            connector_id = await _seed_generation_connector(s, org_id, label="v2")
            await _seed_agent_binding(
                s, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id,
                key=second_stage_metadata_key,
            )
            # story #4110 — crew는 "이 적용의 agent_member_id 전부"라 draft에 reviewer를
            # org 전역으로 하나 더 바인딩해 project 특이(drafter)와 합쳐지는지도 함께 본다.
            from app.models.recipe_role_binding import RecipeRoleBinding
            s.add(RecipeRoleBinding(
                id=uuid.uuid4(), org_id=org_id, project_id=None,
                event_definition_key=second_stage_metadata_key, stage="review", agent_member_id=reviewer_id,
            ))
            await s.commit()
            await _seed_connector_binding(
                s, org_id=org_id, project_id=project_id, stage="live_generation", connector_id=connector_id,
                key=second_stage_metadata_key,
            )
            await _publish_stage(
                s, org_id=org_id, definition_key=second_stage_metadata_key, story_id=story_id,
                stage="draft", requester_id=drafter_id,
            )

            resp = await _publish_stage(
                s, org_id=org_id, definition_key=second_stage_metadata_key, story_id=story_id,
                stage="live_generation", requester_id=drafter_id,
            )

            assert set(resp["broadcast_member_ids"]) == {str(drafter_id), str(reviewer_id)}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resolver_no_fallback_for_unbound_agent_target_stage():
    """회귀 0(#3288 PO 확定 「모르면 안 준다」) — agent-target stage가 미배정이면
    generation_connector 폴백이 번지지 않고 그대로 빈 집합이어야 한다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id)
            story_id = await _seed_story(s, org_id, project_id)
            # draft(agent-target) 바인딩을 만들지 않음 — 미배정 상태로 발행.
            # story #4251 — 첫 stage는 프로젝트에 접근하는 사람이 바인딩 없이 연다(«레시피 시작»). 에이전트가 내려면 draft에
            # 바인딩돼야 해서 «미배정 stage»가 성립하지 않는다.
            from app.dependencies.auth import AuthContext
            from app.routers.events import _publish_registry_event_core
            from tests.test_3475_publishing_metrics import (
                _seed_human as _seed_owner_user,
            )

            owner_user_id = await _seed_owner_user(s, org_id, role="owner")
            resp = await _publish_registry_event_core(
                s, org_id, AuthContext(user_id=str(owner_user_id), email=None, claims={}, org_id=str(org_id)),
                _DEFINITION_KEY, {"work_item_type": "story", "work_item_id": str(story_id), "stage": "draft"},
                BackgroundTasks(),
            )

            assert resp["broadcast_member_ids"] == []
    finally:
        await engine.dispose()
