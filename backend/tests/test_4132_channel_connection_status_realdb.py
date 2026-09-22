"""story #4132([E-RECIPE-1·Phase 3 폴리시] 바인딩된 채널 연결의 «상태»를 crew 에이전트가
읽게) — `GET /api/v2/events/work-items/{type}/{id}/channel-connection`이 발행(published)
단계를 맡은 crew 에이전트에게 자격 없이 {connection_id, provider, status, needs_reauth,
last_verified_at, display_name}만 200으로 준다. 판정 순서는
`get_my_generation_connector`(#4110/#4124)와 완전히 동형(target 문자열만
"generation_connector"→"channel_connection") — 세팅 헬퍼도
test_4110_generation_connector_read_realdb.py를 그대로 미러한다(발명 0)."""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]

_DEFINITION_KEY = "org.e4132.recipe_cap"

_PAYLOAD_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["stage", "work_item_type", "work_item_id"],
    "properties": {
        "stage": {"type": "string", "enum": ["draft", "published"]},
        "work_item_type": {"type": "string"}, "work_item_id": {"type": "string", "format": "uuid"},
    },
}
_ROUTING = {
    "broadcast": {"kind": "recipe_role_binding"},
    "escalation": {"kind": "server_derived", "target": "none"},
}
_STAGE_METADATA = {
    "draft": {"role": "Creator", "action": "초안 작성", "capability": {"kind": "attach_video"}},
    "published": {
        "role": "Publisher", "action": "발행",
        "capability": {"kind": "publish", "target": "channel_connection"},
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


async def _seed_org_project(session, *, slug="e4132"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org4132", slug=slug)
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
        id=uuid.uuid4(), key=key, org_id=org_id, name="테스트 발행 레시피",
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


async def _seed_channel_binding(session, *, org_id, project_id, stage, connection_id, key=_DEFINITION_KEY):
    from app.models.recipe_role_binding import RecipeRoleBinding

    session.add(RecipeRoleBinding(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id,
        event_definition_key=key, stage=stage, channel_connection_id=connection_id,
    ))
    await session.commit()


async def _seed_channel_connection(
    session, org_id, *, status="active", channel="threads", account_label="브랜드 계정",
):
    from app.models.channel_connection import ChannelConnection

    c = ChannelConnection(
        id=uuid.uuid4(), org_id=org_id, channel=channel, account_id=f"acct-{uuid.uuid4().hex[:8]}",
        account_label=account_label, status=status,
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
    from app.routers.events import get_my_channel_connection_status

    return await get_my_channel_connection_status(
        work_item_type, work_item_id, db=session, auth=_auth(caller_id, org_id), org_id=org_id,
    )


async def _advance_to_published(session, *, org_id, project_id, story_id, drafter_id):
    """draft(첫 단계)로 "시작" 표시 후 published로 진행 — 이 엔드포인트와
    get_recipe_start_candidates 둘 다 same SSOT(첫 단계 발행=started)를 쓰므로 draft를
    건너뛰면 "시작 안 됨"으로 판정돼 stage-mismatch 403과 구별이 안 된다."""
    await _publish_stage(session, org_id=org_id, story_id=story_id, stage="draft", requester_id=drafter_id)
    await _publish_stage(session, org_id=org_id, story_id=story_id, stage="published", requester_id=drafter_id)


async def _seed_full_crew_scenario(session, *, connection_status="active"):
    """전형적 성공경로 시나리오 하나 세팅 — 이 파일 대부분의 테스트가 공유."""
    org_id, project_id = await _seed_org_project(session)
    await _seed_definition(session, org_id=org_id)
    drafter_id = await _seed_agent(session, org_id, project_id, name="drafter")
    story_id = await _seed_story(session, org_id, project_id)
    connection_id = await _seed_channel_connection(session, org_id, status=connection_status)
    await _seed_agent_binding(session, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id)
    await _seed_channel_binding(
        session, org_id=org_id, project_id=project_id, stage="published", connection_id=connection_id,
    )
    await _advance_to_published(session, org_id=org_id, project_id=project_id, story_id=story_id, drafter_id=drafter_id)
    return org_id, project_id, drafter_id, story_id, connection_id


# ─── 성공 경로(AC1/AC2 "crew 200") ────────────────────────────────────────────


@pytest.mark.anyio
async def test_crew_agent_reads_status_field_whitelist_when_connection_active():
    """AC1 9번 — crew 에이전트가 published 단계에서 200을 받고, 응답은 정확히
    {connection_id, provider, status, needs_reauth, last_verified_at, display_name}
    6필드뿐(자격·토큰·계정 식별자 0 — 스냅샷으로 고정)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, drafter_id, story_id, connection_id = await _seed_full_crew_scenario(s)

            resp = await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=drafter_id)

            assert resp.model_dump().keys() == {
                "connection_id", "provider", "status", "needs_reauth", "last_verified_at", "display_name",
            }
            assert resp.connection_id == connection_id
            assert resp.provider == "threads"
            assert resp.status == "active"
            assert resp.needs_reauth is False
            assert resp.display_name == "브랜드 계정"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_crew_agent_reads_revoked_connection_as_200_with_needs_reauth():
    """AC1 7번 — status!="active"여도 409가 아니라 200으로 status·needs_reauth에
    그대로 실어 보고한다(generation-connector의 409 RevOKED와 의도적으로 다른 지점 —
    "재인증이 필요하다"는 사실 자체가 이 엔드포인트의 존재 이유)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, drafter_id, story_id, connection_id = await _seed_full_crew_scenario(
                s, connection_status="revoked",
            )

            resp = await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=drafter_id)

            assert resp.status == "revoked"
            assert resp.needs_reauth is True
    finally:
        await engine.dispose()


# ─── 거부 경로(AC2) ─────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_human_caller_403():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, drafter_id, story_id, _connection_id = await _seed_full_crew_scenario(s)
            human_id = await _seed_human(s, org_id, project_id, name="human-caller")

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=human_id)
            assert exc_info.value.status_code == 403
            assert exc_info.value.detail == {"code": "CHANNEL_CONNECTION_READ_AGENT_ONLY"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_outside_crew_403():
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, drafter_id, story_id, _connection_id = await _seed_full_crew_scenario(s)
            outsider_id = await _seed_agent(s, org_id, project_id, name="outsider")

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=outsider_id)
            assert exc_info.value.status_code == 403
            assert exc_info.value.detail == {"code": "CHANNEL_CONNECTION_CREW_ONLY"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_bound_to_other_definition_key_is_broad_crew_not_narrow_crew_403():
    """narrow crew 체크(matched_key 스코프)의 실존 이유 — 넓은 crew(이 project/org에
    적용된 **어느** event_definition_key에든 바인딩된 적 있음)를 통과해도, matched_key
    자신의 crew가 아니면 여전히 403이어야 한다(#4109 PO 결정 — narrow crew_ids 쿼리를
    지우면(broad 체크만 남으면) 이 caller가 통과해 200을 받아 RED)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, drafter_id, story_id, _connection_id = await _seed_full_crew_scenario(s)

            # 다른 event_definition_key에 바인딩된 에이전트 — applied_keys 집합엔
            # 들어가(넓은 crew 소속) STAGE_MISMATCH는 피하지만, matched_key(_DEFINITION_KEY)
            # crew는 아니다.
            other_key = "org.e4132.other_recipe"
            await _seed_definition(s, org_id=org_id, key=other_key)
            other_key_member_id = await _seed_agent(s, org_id, project_id, name="other-key-member")
            await _seed_agent_binding(
                s, org_id=org_id, project_id=project_id, stage="draft",
                agent_id=other_key_member_id, key=other_key,
            )

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=other_key_member_id)
            assert exc_info.value.status_code == 403
            assert exc_info.value.detail == {"code": "CHANNEL_CONNECTION_CREW_ONLY"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_agent_outside_crew_with_revoked_connection_still_403_not_200():
    """뮤테이션 pin(AC2 명시) — 판정 순서(넓은crew→stage→좁은crew→바인딩→연결조회)를
    바인딩/연결조회가 crew 판정보다 앞으로 되돌리면, crew 밖 에이전트도 커넥션이
    revoked인지 200으로 알 수 있게 된다 — 이 테스트가 그 되돌림을 403→200으로 잡는다."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id, drafter_id, story_id, _connection_id = await _seed_full_crew_scenario(
                s, connection_status="revoked",
            )
            outsider_id = await _seed_agent(s, org_id, project_id, name="outsider")

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=outsider_id)
            assert exc_info.value.status_code == 403
            assert exc_info.value.detail == {"code": "CHANNEL_CONNECTION_CREW_ONLY"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_binding_not_found_404():
    """AC1 6번 — matched stage까지는 도달(crew 판정 통과)했지만 그 stage에
    channel_connection_id 바인딩 자체가 없으면 404."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            story_id = await _seed_story(s, org_id, project_id)
            await _seed_agent_binding(s, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id)
            # published 바인딩(channel_connection_id) 자체를 안 만든다.
            await _seed_agent_binding(
                s, org_id=org_id, project_id=project_id, stage="published", agent_id=drafter_id,
            )
            await _advance_to_published(s, org_id=org_id, project_id=project_id, story_id=story_id, drafter_id=drafter_id)

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=drafter_id)
            assert exc_info.value.status_code == 404
            assert exc_info.value.detail == {"code": "CHANNEL_CONNECTION_BINDING_NOT_FOUND"}
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_zero_binding_agent_gets_crew_only_not_stage_mismatch():
    """#4124가 generation-connector에 고친 넓은crew-사전관문을 이 새 엔드포인트에도
    같은 순서로 심었는지 고정 — 이 project/org 어느 적용에도 전혀 안 묶인(바인딩 0건)
    에이전트가 아직 published에 도달 안 한 스토리를 조회하면, stage-매칭이 아니라
    CREW_ONLY로 먼저 막혀야 한다(#4110/#4124와 동형 pin — 스토리는 draft까지만
    진행시켜 stage-mismatch 사유가 자연스레 있는 상황에서도)."""
    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_definition(s, org_id=org_id)
            drafter_id = await _seed_agent(s, org_id, project_id, name="drafter")
            outsider_id = await _seed_agent(s, org_id, project_id, name="outsider")
            story_id = await _seed_story(s, org_id, project_id)
            connection_id = await _seed_channel_connection(s, org_id)
            await _seed_agent_binding(s, org_id=org_id, project_id=project_id, stage="draft", agent_id=drafter_id)
            await _seed_channel_binding(
                s, org_id=org_id, project_id=project_id, stage="published", connection_id=connection_id,
            )
            await _publish_stage(s, org_id=org_id, story_id=story_id, stage="draft", requester_id=drafter_id)

            with pytest.raises(HTTPException) as exc_info:
                await _call_endpoint(s, org_id=org_id, work_item_id=story_id, caller_id=outsider_id)
            assert exc_info.value.status_code == 403
            assert exc_info.value.detail == {"code": "CHANNEL_CONNECTION_CREW_ONLY"}
    finally:
        await engine.dispose()
