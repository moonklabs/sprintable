"""story #2693([BE·이벤트] publish_event notify_member_id가 org 비회원 UUID여도 400 대신
«유령 대화» 생성+reach=1 거짓 성공) — PO 자체 사고(customer-zero) 재현+수정.

배경: `resolve_routing_leg`의 `kind="payload_field"` 분기가 payload에서 뽑은 UUID를
문법(파싱) 검증만 하고 **이 org의 실존 회원인지는 확認하지 않았다** — 존재하지 않는
member_id도 그대로 escalation/broadcast 대상에 섞여 `_get_or_create_event_conversation`이
그 UUID를 참가자로 앉힌 conversation을 만들고 메시지까지 저장했다(ConversationParticipant.
member_id에 FK가 없어 조용히 통과 — story #2697 그라운딩에서 이미 확인된 동형 갭).
`extra_broadcast_member_ids`도 같은 결함 클래스였다(filter_org_member_ids로 걸러내되
그냥 조용히 drop하고 발행을 진행 — "존재 안 하면 거부"가 아니라 "존재하는 것만 취급").

검증 축(AC):
  ①payload_field routing이 해석한 member_id가 이 org의 활성 회원이 아니면 400 — 이벤트·
    conversation·메시지 어느 것도 생성되지 않는다(원자성 실측: routing 해석이 그 어떤
    DB write보다 먼저라 라우터 함수 자체가 자연히 이 성질을 갖는다).
  ②extra_broadcast_member_ids도 동일 검증(더 이상 silent drop 아님).
  ③양성대조: 존재하는 회원 UUID → 기존 동작 그대로(회귀 0, test_2633이 이미 커버 — 여기선
    extra_broadcast_member_ids 축만 보강).
  ④mutation-kill: existence check를 되돌리면 정확히 이 결함(유령 conversation 생성)이
    재현되는지 확인(별도 절 — 코드 레벨에서 수행, 테스트 파일엔 결과만 남김).

AC4(이미 생긴 유령 conversation 정리 방침)는 코드 스코프 밖 — story 본문에 1줄로 기록.
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
        "_m0245c2693", os.path.join(os.path.dirname(__file__), "..", "alembic", "versions", "0245_event_definitions.py"),
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


async def _seed_org_project(session, *, slug="acme2693"):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2693", slug=slug)
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


def _auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _fake_request(*, project_id_header: uuid.UUID | None = None) -> "StarletteRequest":
    from starlette.requests import Request as StarletteRequest

    headers = []
    if project_id_header is not None:
        headers.append((b"x-project-id", str(project_id_header).encode()))
    return StarletteRequest(scope={"type": "http", "headers": headers})


async def _counts(session):
    from sqlalchemy import func, select
    from app.models.conversation import Conversation, ConversationMessage

    conv_count = (await session.execute(select(func.count()).select_from(Conversation))).scalar_one()
    msg_count = (await session.execute(select(func.count()).select_from(ConversationMessage))).scalar_one()
    return conv_count, msg_count


# ─── ① payload_field routing — 비회원 UUID → 400, 원자성(conv/msg 0건 생성) ─────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_unknown_assignee_member_id_400_no_ghost_conversation():
    """PO 원 사고의 직접 재현 — preset.work.assigned의 assignee_member_id(kind=payload_field)
    가 syntactically-valid하지만 이 org에 없는 UUID → 400, conversation/message 0건 생성."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            story_id = await _seed_story(s, org_id, project_id)
            ghost_id = uuid.uuid4()  # 이 org 어디에도 없는 UUID(PO 실사고와 동형)

            before = await _counts(s)
            body = EventPublishRequest(
                definition_key="preset.work.assigned",
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "assignee_member_id": str(ghost_id),
                },
            )
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
            assert ei.value.detail["code"] == "invalid_payload"
            assert str(ghost_id) in ei.value.detail["message"]

            after = await _counts(s)
            assert after == before, "비회원 UUID 거부 시 conversation/message가 하나도 생기면 안 됨(원자성)"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_known_assignee_member_id_200_no_regression():
    """양성대조 — 실존 회원이면 기존 동작 그대로(test_2633과 동형, 여기선 원자성 카운트도 같이 확인)."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            assignee_id = await _seed_agent(s, org_id, project_id, name="assignee")
            story_id = await _seed_story(s, org_id, project_id, assignee_id=assignee_id)

            before = await _counts(s)
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

            after = await _counts(s)
            assert after[0] == before[0] + 1  # conversation 1건 생성
            assert after[1] == before[1] + 1  # message 1건 생성
    finally:
        await engine.dispose()


# ─── ② extra_broadcast_member_ids — 비회원 id 포함 시 400, 원자성 ───────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_unknown_extra_broadcast_member_id_400_no_ghost_conversation():
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            stakeholder_id = await _seed_agent(s, org_id, project_id, name="stakeholder")
            story_id = await _seed_story(s, org_id, project_id, human_owner_member_id=stakeholder_id)
            ghost_id = uuid.uuid4()

            before = await _counts(s)
            body = EventPublishRequest(
                definition_key="preset.gate.verdict",
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "gate_type": "merge", "verdict": "approved",
                },
                extra_broadcast_member_ids=[ghost_id],
            )
            with pytest.raises(HTTPException) as ei:
                await publish_registry_event(
                    body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 400
            assert ei.value.detail["code"] == "invalid_payload"
            assert str(ghost_id) in ei.value.detail["message"]

            after = await _counts(s)
            assert after == before
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_publish_known_extra_broadcast_member_id_200_no_regression():
    """양성대조 — 실존 회원의 extra_broadcast_member_ids는 broadcast에 정상 합류(무회귀)."""
    from app.routers.events import EventPublishRequest, publish_registry_event

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_preset_definitions(s)
            publisher_id = await _seed_agent(s, org_id, project_id, name="publisher")
            stakeholder_id = await _seed_agent(s, org_id, project_id, name="stakeholder")
            extra_id = await _seed_agent(s, org_id, project_id, name="extra")
            story_id = await _seed_story(s, org_id, project_id, human_owner_member_id=stakeholder_id)

            body = EventPublishRequest(
                definition_key="preset.gate.verdict",
                payload={
                    "work_item_type": "story", "work_item_id": str(story_id),
                    "gate_type": "merge", "verdict": "approved",
                },
                extra_broadcast_member_ids=[extra_id],
            )
            resp = await publish_registry_event(
                body, BackgroundTasks(), _fake_request(), db=s, auth=_auth(publisher_id, org_id), org_id=org_id,
            )
            assert str(extra_id) in resp["broadcast_member_ids"]
            assert str(stakeholder_id) in resp["broadcast_member_ids"]
    finally:
        await engine.dispose()


# ─── resolve_routing_leg 단위 — 존재 검증 자체의 최소 재현 ──────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_resolve_routing_leg_payload_field_unknown_member_raises():
    from app.services.event_routing_resolver import UnknownRoutingMemberError, resolve_routing_leg

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, _project_id = await _seed_org_project(s)
            ghost_id = uuid.uuid4()
            with pytest.raises(UnknownRoutingMemberError):
                await resolve_routing_leg(
                    {"kind": "payload_field", "target": "assignee", "member_id_field": "assignee_member_id"},
                    payload={"assignee_member_id": str(ghost_id)},
                    org_id=org_id, db=s,
                )
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_resolve_routing_leg_payload_field_known_member_returns_id_no_regression():
    from app.services.event_routing_resolver import resolve_routing_leg

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            member_id = await _seed_agent(s, org_id, project_id)
            ids = await resolve_routing_leg(
                {"kind": "payload_field", "target": "assignee", "member_id_field": "assignee_member_id"},
                payload={"assignee_member_id": str(member_id)},
                org_id=org_id, db=s,
            )
            assert ids == {member_id}
    finally:
        await engine.dispose()
