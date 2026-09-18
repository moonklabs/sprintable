"""story #2633(이벤트 레지스트리 P1a) — POST /api/v2/events/publish.

doc event-registry-core-p1-plan §2-2. 검증 축:
- AC1: 프리셋 발행이 실왕복으로 도달 — escalation=액션 대상(mentioned_ids)·broadcast=공람
  (참가자)이 구분돼 실측된다.
- AC2: 신규 전달 계통 금지 — publish_registry_event가 send_message()를 그대로 호출한다는 사실 자체가
  구조적 보증(별도 배달 로직 부재)이므로, 여기서는 그 위임의 결과(mentioned_ids가 정확히
  escalation_ids로 실린 메시지가 생성됨)로 간접 검증한다. route_message/webhook parity 자체는
  #2620/test_conversations.py가 이미 회귀 고정한 축이라 여기서 재검증하지 않는다.
- AC3: 스키마 위반·미존재 key는 4xx 명시 오류.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException

_REAL_DB_URL = __import__("os").getenv("PARITY_TEST_DATABASE_URL") or __import__("os").getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """story a05da51b — 이 파일은 publish_registry_event/publish_preset_event/
    transition_gate/send_message 중 하나를 호출해 실제로 메시지를 발행하거나 게이트를
    전이시킨다 — `send_message`의 background task(`mark_agent_replied`)가 이 파일의
    throwaway 엔진이 아니라 `app.core.database.async_session_factory`(전역·프로세스
    수명 엔진)를 쓴다. destructive_schema 마커 파일이라 story #3330(PR#3711)이 conftest.py
    에 심은 전역 autouse(non-destructive 전용 스코프)의 적용 대상이 아니다 — 이 파일
    자신의 여러 테스트가 한 pytest 세션 안에서 순차 실행되며 같은 전역 엔진을 반복
    사용하므로, dispose 없이 두면 pytest-anyio의 테스트별 새 이벤트 루프 사이에서 커넥션
    누수/`Event loop is closed`로 이어질 수 있다(story #3330/PR#3711 실사고 — test_3330_
    gate_verdict_notification.py에서 최초 재현). 이 realdb 하네스의 표준 방어 fixture
    재사용(새 로직 0, story a05da51b — scripts/lint_destructive_publish_path_dispose_
    fixture.py 가드 대상)."""
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


def _load_seed_definitions():
    import importlib.util
    import os

    spec = importlib.util.spec_from_file_location(
        "_m0245c", os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0245_event_definitions.py"),
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return {key: (payload_schema, routing) for key, payload_schema, routing in m._SEED}


async def _seed_preset_definitions(session):
    from app.models.event_definition import EventDefinition

    for key, (payload_schema, routing) in _load_seed_definitions().items():
        session.add(EventDefinition(
            id=uuid.uuid4(), key=key, org_id=None, payload_schema=payload_schema, routing=routing,
        ))
    await session.commit()


async def _seed_org_project(session, *, slug="acme"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2633", slug=slug)
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id, *, name="agent"):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent", name=name, is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


async def _seed_story(session, org_id, project_id, *, assignee_id=None, human_owner_member_id=None):
    from app.models.pm import Story

    story = Story(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="S",
        assignee_id=assignee_id, human_owner_member_id=human_owner_member_id,
    )
    session.add(story)
    await session.commit()
    return story.id


async def _seed_goal(session, org_id, project_id, *, assignee_id=None):
    from app.models.pm import Goal

    goal = Goal(id=uuid.uuid4(), org_id=org_id, project_id=project_id, title="G", assignee_id=assignee_id)
    session.add(goal)
    await session.commit()
    return goal.id


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request(*, project_id_header: uuid.UUID | None = None) -> "StarletteRequest":
    """story #2674 — publish_registry_event가 이제 request(X-Project-Id 헤더 폴백)를 받는다.
    test_2274_cron_orphan_check_realdb.py의 기존 관례(최소 ASGI scope)와 동일 패턴 — 신규
    발명 아님. headers는 ASGI 규약대로 (byte, byte) 튜플 목록."""
    from starlette.requests import Request as StarletteRequest

    headers = []
    if project_id_header is not None:
        headers.append((b"x-project-id", str(project_id_header).encode()))
    return StarletteRequest(scope={"type": "http", "headers": headers})


# ─── AC1: 프리셋 발행 실왕복 — escalation/broadcast 구분 ───────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_work_assigned_escalation_is_assignee_mentioned():
    from app.routers.events import EventPublishRequest, publish_registry_event
    from app.models.conversation import ConversationMessage
    from sqlalchemy import select

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            assignee_id = await _seed_agent(s, org_id, project_id, name="assignee")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=assignee_id)

            body = EventPublishRequest(
                definition_key="preset.work.assigned",
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "assignee_member_id": str(assignee_id),
                },
            )
            resp = await publish_registry_event(
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp["escalation_member_ids"] == [str(assignee_id)]
            assert str(assignee_id) in resp["broadcast_member_ids"]  # story_stakeholders에도 포함

            msg = (await s.execute(
                select(ConversationMessage).where(ConversationMessage.id == uuid.UUID(resp["message_id"]))
            )).scalar_one()
            assert msg.mentioned_ids == [assignee_id]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_gate_verdict_no_escalation_broadcasts_to_stakeholders():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            stakeholder_id = await _seed_agent(s, org_id, project_id, name="stakeholder")
            story_id = await _seed_story(s, org_id, project_id, human_owner_member_id=stakeholder_id)

            body = EventPublishRequest(
                definition_key="preset.gate.verdict",
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "gate_type": "merge", "verdict": "approved",
                },
            )
            resp = await publish_registry_event(
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp["escalation_member_ids"] == []  # verdict는 결과 통지, 개입 요청 없음
            assert str(stakeholder_id) in resp["broadcast_member_ids"]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_goal_measured_resolves_goal_owner():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            owner_id = await _seed_agent(s, org_id, project_id, name="owner")
            goal_id = await _seed_goal(s, org_id, project_id, assignee_id=owner_id)

            body = EventPublishRequest(
                definition_key="preset.goal.measured",
                payload={"goal_id": str(goal_id), "metric_value": 12.5},
            )
            resp = await publish_registry_event(
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp["broadcast_member_ids"] == [str(owner_id)]
    finally:
        await engine.dispose()


# ─── 참가자 집합 재사용 — 대화 증식 방지 ────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_reuses_conversation_for_same_participant_set():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            assignee_id = await _seed_agent(s, org_id, project_id, name="assignee")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=assignee_id)

            def _body():
                from app.routers.events import EventPublishRequest as R
                return R(
                    definition_key="preset.work.assigned",
                    payload={
                        "work_item_type": "story", "work_item_id": str(story_id),
                        "assignee_member_id": str(assignee_id),
                    },
                )

            resp1 = await publish_registry_event(
                _body(), BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            resp2 = await publish_registry_event(
                _body(), BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert resp1["conversation_id"] == resp2["conversation_id"]
            assert resp1["message_id"] != resp2["message_id"]
    finally:
        await engine.dispose()


# ─── story #2674 — work_item/goal 참조 없는 커스텀 이벤트의 project 폴백 ──────────────
# #2670 정의기 판별자 3차 실측(2026-08-16)이 특정한 실사고: 신호형·측정형류(work_item 참조
# 필드 자체가 없음)를 테스트 발행하면 project 해소가 항상 400이었다. 폴백 사슬(호출 컨텍스트
# — X-Project-Id 헤더/멤버 단일 접근가능 프로젝트)이 실제로 동작하는지, 그리고 기존
# 참조기반 해소·dangling 참조 거부(AC2 무회귀)는 안 깨지는지 검증.

async def _seed_custom_signal_definition(session, org_id, *, key="org.acme.acceptance_check_cycle"):
    """work_item/goal 참조 필드가 아예 없는 정의기 신호형류 — #2670의 실 재현 모양
    (payload_schema에 kind만 있고 work_item_type/id·goal_id 부재)."""
    from app.models.event_definition import EventDefinition

    session.add(EventDefinition(
        id=uuid.uuid4(), key=key, org_id=org_id,
        payload_schema={
            "type": "object", "properties": {"kind": {"type": "string", "enum": ["ok"]}},
            "required": ["kind"], "additionalProperties": False,
        },
        routing={
            "escalation": {"kind": "server_derived", "target": "none"},
            "broadcast": {"kind": "server_derived", "target": "none"},
        },
    ))
    await session.commit()


async def _seed_human_org_admin(session, org_id, project_id, *, name="admin"):
    """#2670은 화면(FE 관리자 페이지, isAdmin 전용) 발행이라 실 재현 caller는 JWT 휴먼이다.
    org owner/admin은 has_project_access/accessible_project_ids_in_org 양쪽의 admin_branch로
    org 내 모든 project에 접근한다(project_access.py 참조) — 프로젝트별 grant를 따로 안 심어도
    되는 가장 단순한 실증 caller. resolve_member의 human 분기가 반환하는 id는 org_member.id인데
    conversations.created_by는 team_members FK라, om.id와 동일한 id의 team_member(human)도
    같이 심는다(휴먼 신원의 org/project 두 표가 같은 id를 공유하는 이 코드베이스의 관례)."""
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.team import TeamMember

    user_id = uuid.uuid4()
    session.add(User(id=user_id, email=f"{name}-{user_id.hex[:8]}@test.com", hashed_password="x"))
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role="admin")
    session.add(om)
    session.add(TeamMember(
        id=om.id, org_id=org_id, project_id=project_id, type="human", user_id=user_id,
        name=name, is_active=True,
    ))
    await session.commit()
    return user_id


def _human_auth(user_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    """JWT 휴먼 — _auth(에이전트 API키)와 대칭. api_key_id 없음이 resolve_member의 human 분기
    판별자(member_resolver.py:_resolve_member_legacy)."""
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={"app_metadata": {}}, org_id=str(org_id))


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_no_reference_resolves_project_via_header():
    """AC1 — work_item/goal 참조가 없어도 X-Project-Id 헤더가 있으면 그 프로젝트로 발행 성공
    (#2670 화면 재현 caller=JWT 휴먼 admin)."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_custom_signal_definition(s, org_id)
            user_id = await _seed_human_org_admin(s, org_id, project_id)

            body = EventPublishRequest(definition_key="org.acme.acceptance_check_cycle", payload={"kind": "ok"})
            resp = await publish_registry_event(
                body, BackgroundTasks(), _fake_request(project_id_header=project_id),
                db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
            )
            assert resp["message_id"]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_no_reference_resolves_project_via_single_accessible_project():
    """AC1 변형 — 헤더도 없지만(#2670 FE가 실제로 안 보내는 케이스) 발행자가 이 org에서
    접근 가능한 project가 단 하나면 그 프로젝트로 폴백 성공(멤버 기본/단일 접근가능
    프로젝트 tier — resolve_required_project_id의 _resolve_project_default)."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_custom_signal_definition(s, org_id)
            user_id = await _seed_human_org_admin(s, org_id, project_id)

            body = EventPublishRequest(definition_key="org.acme.acceptance_check_cycle", payload={"kind": "ok"})
            resp = await publish_registry_event(
                body, BackgroundTasks(), _fake_request(), db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
            )
            assert resp["message_id"]
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_no_reference_no_context_still_400():
    """음성대조(AC) — 참조도 컨텍스트도(헤더 없음·발행자가 이 org의 org_member조차 아님)
    없으면 여전히 현행 문구 그대로 명시 거부한다(폴백이 뭐든 조용히 골라주지 않는다)."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org_project(s)
            await _seed_custom_signal_definition(s, org_id)
            from app.models.user import User

            # org_member 행이 아예 없는 유저 — accessible_project_ids_in_org가 0건, resolve_member도
            # "Organization member not found"로 먼저 거부할 수 있어 그 경우까지 400 하나로 포용.
            phantom_user_id = uuid.uuid4()
            s.add(User(id=phantom_user_id, email=f"phantom-{phantom_user_id.hex[:8]}@test.com", hashed_password="x"))
            await s.commit()

            body = EventPublishRequest(definition_key="org.acme.acceptance_check_cycle", payload={"kind": "ok"})
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), _fake_request(),
                    db=s, auth=_human_auth(phantom_user_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_dangling_goal_reference_still_400_no_context_fallback():
    """AC2 무회귀 — goal_id를 «줬는데» 그 goal이 존재하지 않는 경우(참조 시도는 있었음)는
    컨텍스트 폴백을 안 타고 그대로 즉시 거부한다(test_publish_unresolvable_project_400과
    동일 계약 — 참조 필드 부재와 참조 실패를 다른 사건으로 가르는 #2674의 핵심 구분).
    발행자는 X-Project-Id 헤더까지 보내는 org admin(폴백이 있었다면 100% 성공했을 가장
    강한 조건) — attempted_reference 게이트가 실제로 그 성공 경로를 막는지까지 검증한다."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            user_id = await _seed_human_org_admin(s, org_id, project_id)

            body = EventPublishRequest(
                definition_key="preset.goal.measured",
                payload={"goal_id": str(uuid.uuid4()), "metric_value": 1},  # 존재하지 않는 goal
            )
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), _fake_request(project_id_header=project_id),
                    db=s, auth=_human_auth(user_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
            assert "project를 해소할 수 없습니다" in str(ei.value.detail)
    finally:
        await engine.dispose()


# ─── AC3: 4xx 명시 오류 ──────────────────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_unknown_definition_key_404():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            publisher_id = await _seed_agent(s, org_id, project_id)

            body = EventPublishRequest(definition_key="preset.does.not_exist", payload={})
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 404
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_schema_violation_400():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id)

            body = EventPublishRequest(
                definition_key="preset.gate.verdict",
                payload={"work_item_type": "story"},  # 필수 필드 대량 누락
            )
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
            # story #2634 후속(#2633 정합): api_client.py의 _extract_error_message가 인식하는
            # {code,message} shape — errors 배열(기계가 읽을 상세)은 그대로 유지.
            assert ei.value.detail["code"] == "invalid_payload"
            assert ei.value.detail["message"]
            assert ei.value.detail["errors"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_resolve_routing_leg_missing_payload_field_raises():
    """payload_field routing이 요구하는 필드가 payload에 없거나 비면 명시 오류 — 조용한
    무해석 금지. preset.work.assigned는 스키마 자체가 assignee_member_id를 required로
    걸어 이 경로가 엔드포인트 레벨에선 항상 스키마 검증에 먼저 걸리므로(AC3와 중복 검증
    방지), 해석기 함수를 직접 호출해 이 축을 독립 검증한다."""
    from app.services.event_routing_resolver import MissingRoutingPayloadFieldError, resolve_routing_leg
    from unittest.mock import AsyncMock

    with pytest.raises(MissingRoutingPayloadFieldError):
        await resolve_routing_leg(
            {"kind": "payload_field", "target": "assignee", "member_id_field": "assignee_member_id"},
            payload={"work_item_type": "story"},  # assignee_member_id 없음
            org_id=uuid.uuid4(), db=AsyncMock(),
        )


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_unresolvable_project_400():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id)

            body = EventPublishRequest(
                definition_key="preset.goal.measured",
                payload={"goal_id": str(uuid.uuid4()), "metric_value": 1},  # 존재하지 않는 goal
            )
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
    finally:
        await engine.dispose()


# ─── 이해관계자 해석기 — story 복수 축(assignee_id·human_owner_member_id·StoryAssignee) ──

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_resolve_work_item_stakeholders_unions_all_story_axes():
    from app.services.event_routing_resolver import resolve_routing_leg
    from app.models.story_assignee import StoryAssignee

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            assignee_id = await _seed_agent(s, org_id, project_id, name="assignee")
            owner_id = await _seed_agent(s, org_id, project_id, name="owner")
            extra_id = await _seed_agent(s, org_id, project_id, name="extra")
            story_id = await _seed_story(
                s, org_id, project_id, assignee_id=assignee_id, human_owner_member_id=owner_id,
            )
            s.add(StoryAssignee(id=uuid.uuid4(), org_id=org_id, story_id=story_id, member_id=extra_id))
            await s.commit()

            ids = await resolve_routing_leg(
                {"kind": "server_derived", "target": "work_item_stakeholders"},
                payload={"work_item_type": "story", "work_item_id": str(story_id)},
                org_id=org_id, db=s,
            )
            assert ids == {assignee_id, owner_id, extra_id}
    finally:
        await engine.dispose()
