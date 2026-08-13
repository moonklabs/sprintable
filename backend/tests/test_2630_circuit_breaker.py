"""story #2630: 폭주 에피소드 «자동 차단»(서킷브레이커) — #2626 판별자 위의 집행 계층.

#2626이 만든 속도 기반 에피소드 판별(chain_escalation.py)은 «관측»만 했다 — 이 파일은 그
위에 얹은 «집행»(chain_circuit_breaker 테이블 + send_message 발신 차단 + 수동/자동 해제)을
검증한다:
- circuit_breaker_mode='block'(기본): 에피소드 시작 시 서킷 open, 알림 event_type이
  conversation.circuit_breaker_opened로 바뀐다(reference_id=breaker.id).
- circuit_breaker_mode='notify_only': #2626 원 계약(서킷 안 열림·event_type 그대로) 보존.
- 서킷 open은 멱등 — 이미 열려 있는 대화에 재폭주가 와도 중복 행이 안 생긴다(부분 unique
  index, 마이그레이션 0244).
- circuit_breaker_release_mode='manual'(기본): 에피소드가 속도축에서 자연 해소돼도 서킷은
  안 닫힌다(사람이 안 눌렀으니) — auto는 org 옵트인일 때만 자연 해소를 따라 닫힌다.
- send_message(): agent 발신은 열린 서킷에서 423(명시 오류, 조용한 유실 없음) — **human
  발신은 서킷 상태와 무관하게 항상 통과**(페드루 필수수정 2026-08-13: 사람의 개입이 사태
  수습의 정공 경로).
- 해제 엔드포인트: human org owner/admin 전용, 멱등(중복 호출도 에러 없이 no-op).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

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


async def _seed_org_project(session):
    from app.models.organization import Organization
    from app.models.project import Project

    org = Organization(id=uuid.uuid4(), name="Org2630", slug=f"org2630-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_agent(session, org_id, project_id):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type="agent",
        name="agent", is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


async def _seed_human(session, org_id, project_id=None, *, role="member"):
    """User + OrgMember(레거시 신원 해소 경로) + 동일 id의 TeamMember(type=human) — 프로덕션
    member-sync가 성립했을 때의 모양을 재현(conversation_participants.member_id FK가
    team_members를 향하므로, 참가자로 실제 발화하려면 이 짝이 있어야 한다 — 없으면 그 자체가
    별도 결함 클래스인 members_sync 갭이지 이 스토리의 스코프가 아니다)."""
    from app.models.user import User
    from app.models.project import OrgMember
    from app.models.team import TeamMember

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"{user_id.hex[:8]}@test.local", hashed_password="x",
    ))
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=user_id, role=role)
    session.add(om)
    session.add(TeamMember(
        id=om.id, org_id=org_id, project_id=project_id, type="human",
        name="human", is_active=True,
    ))
    await session.commit()
    return user_id, om.id


async def _seed_conversation(session, org_id, project_id, *, conv_type="group"):
    from app.models.conversation import Conversation

    conv = Conversation(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type=conv_type)
    session.add(conv)
    await session.commit()
    return conv.id


async def _add_participant(session, conversation_id, member_id):
    from app.models.conversation import ConversationParticipant

    session.add(ConversationParticipant(conversation_id=conversation_id, member_id=member_id))
    await session.commit()


async def _seed_org_owner(session, org_id, *, role="owner"):
    from app.models.project import OrgMember

    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=uuid.uuid4(), role=role)
    session.add(om)
    await session.commit()
    return om.id


async def _seed_messages(session, conversation_id, sender_id, count, *, ages_seconds=0):
    from app.models.conversation import ConversationMessage

    ts = datetime.now(timezone.utc) - timedelta(seconds=ages_seconds)
    for _ in range(count):
        session.add(ConversationMessage(
            id=uuid.uuid4(), conversation_id=conversation_id, sender_id=sender_id,
            content="msg", created_at=ts,
        ))
    await session.commit()


async def _seed_org_config(session, org_id, **overrides):
    from app.models.chain_escalation_org_config import ChainEscalationOrgConfig

    session.add(ChainEscalationOrgConfig(id=uuid.uuid4(), org_id=org_id, **overrides))
    await session.commit()


def _fakeredis_client():
    aioredis = pytest.importorskip("fakeredis.aioredis")
    server = aioredis.FakeServer()
    return aioredis.FakeRedis(server=server, decode_responses=True)


def _agent_auth(agent_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(agent_id), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(org_id),
    )


def _human_auth(user_id: uuid.UUID, org_id: uuid.UUID) -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(org_id))


async def _open_breaker_count(session, conversation_id) -> int:
    from sqlalchemy import select, func
    from app.models.chain_circuit_breaker import ChainCircuitBreaker

    return (await session.execute(
        select(func.count()).select_from(ChainCircuitBreaker).where(
            ChainCircuitBreaker.conversation_id == conversation_id,
            ChainCircuitBreaker.released_at.is_(None),
        )
    )).scalar_one()


# ─── 서킷 open — block 모드(기본) ────────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_block_mode_opens_breaker_and_notification_reflects_it():
    """기본 org 설정(circuit_breaker_mode='block')에서 에피소드 시작 시 서킷이 열리고,
    알림 event_type이 circuit_breaker_opened로·reference_id가 breaker.id로 바뀐다."""
    from app.services.chain_escalation import evaluate_unsupervised_chain_episode

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            owner_id = await _seed_org_owner(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            conv_id = await _seed_conversation(s, org_id, project_id)
            await _seed_messages(s, conv_id, agent_id, 20, ages_seconds=10)  # 임계(15) 초과

            client = _fakeredis_client()
            dn = AsyncMock()
            with patch("app.services.redis_shared.get_client", return_value=client), \
                 patch("app.services.notification_dispatch.dispatch_notification", dn):
                await evaluate_unsupervised_chain_episode(
                    s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                )
                dn.assert_awaited_once()
                kw = dn.await_args.kwargs
                assert kw["event_type"] == "conversation.circuit_breaker_opened"
                assert kw["target_member_ids"] == [owner_id]

                from app.services.chain_escalation import get_open_circuit_breaker_id
                breaker_id = await get_open_circuit_breaker_id(s, conv_id)
                assert breaker_id is not None
                assert kw["reference_id"] == breaker_id
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_notify_only_mode_preserves_2626_contract_no_breaker():
    """org가 circuit_breaker_mode='notify_only'로 명시 오버라이드하면 #2626 원 계약(관측만·
    서킷 안 열림·event_type=unsupervised_chain_expired) 그대로."""
    from app.services.chain_escalation import evaluate_unsupervised_chain_episode

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_org_owner(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            conv_id = await _seed_conversation(s, org_id, project_id)
            await _seed_messages(s, conv_id, agent_id, 20, ages_seconds=10)
            await _seed_org_config(s, org_id, circuit_breaker_mode="notify_only")

            client = _fakeredis_client()
            dn = AsyncMock()
            with patch("app.services.redis_shared.get_client", return_value=client), \
                 patch("app.services.notification_dispatch.dispatch_notification", dn):
                await evaluate_unsupervised_chain_episode(
                    s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                )
                assert dn.await_args.kwargs["event_type"] == "conversation.unsupervised_chain_expired"
            assert await _open_breaker_count(s, conv_id) == 0
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_reburst_while_already_open_is_idempotent_no_duplicate_row():
    """release_mode 기본(manual)이라 해소돼도 안 닫히는 서킷에 재폭주가 와도(marker
    started 재발화) 중복 open 행이 안 생긴다 — 부분 unique index(마이그레이션 0244) +
    on_conflict_do_nothing 멱등."""
    from app.services.chain_escalation import evaluate_unsupervised_chain_episode

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_org_owner(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            conv_id = await _seed_conversation(s, org_id, project_id)
            await _seed_messages(s, conv_id, agent_id, 20, ages_seconds=10)

            client = _fakeredis_client()
            dn = AsyncMock()
            with patch("app.services.redis_shared.get_client", return_value=client), \
                 patch("app.services.notification_dispatch.dispatch_notification", dn), \
                 patch("app.services.chain_escalation._claim_flap_cooldown_slot", return_value=True):
                await evaluate_unsupervised_chain_episode(
                    s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                )
                assert await _open_breaker_count(s, conv_id) == 1

                async def _low_velocity(db, conversation_id, window_seconds):  # noqa: ARG001
                    return 2

                with patch(
                    "app.services.chain_escalation._recent_message_velocity", side_effect=_low_velocity,
                ):
                    await evaluate_unsupervised_chain_episode(
                        s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                    )  # 해소 평가 — manual이라 breaker는 안 닫힘
                assert await _open_breaker_count(s, conv_id) == 1, "manual release_mode는 해소돼도 서킷 유지"

                # 재폭주 — started가 다시 뜬다. 이미 open인 서킷에 또 열려는 시도가 멱등해야.
                await evaluate_unsupervised_chain_episode(
                    s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                )
                assert await _open_breaker_count(s, conv_id) == 1, "재폭주가 중복 open 행을 만들면 안 됨"
    finally:
        await engine.dispose()


# ─── 해제 — manual vs auto ───────────────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_release_mode_auto_closes_on_natural_resolution():
    """org가 circuit_breaker_release_mode='auto'면 에피소드 자연 해소 시 서킷도 같이 닫힌다
    (released_by는 NULL — 사람이 안 눌렀다는 사실 자체가 감사 대상)."""
    from app.services.chain_escalation import evaluate_unsupervised_chain_episode, get_open_circuit_breaker_id

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_org_owner(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            conv_id = await _seed_conversation(s, org_id, project_id)
            await _seed_messages(s, conv_id, agent_id, 20, ages_seconds=10)
            await _seed_org_config(s, org_id, circuit_breaker_release_mode="auto")

            client = _fakeredis_client()
            dn = AsyncMock()
            with patch("app.services.redis_shared.get_client", return_value=client), \
                 patch("app.services.notification_dispatch.dispatch_notification", dn):
                await evaluate_unsupervised_chain_episode(
                    s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                )
                assert await get_open_circuit_breaker_id(s, conv_id) is not None

                async def _low_velocity(db, conversation_id, window_seconds):  # noqa: ARG001
                    return 2

                with patch(
                    "app.services.chain_escalation._recent_message_velocity", side_effect=_low_velocity,
                ):
                    await evaluate_unsupervised_chain_episode(
                        s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                    )
                assert await get_open_circuit_breaker_id(s, conv_id) is None, "auto release_mode는 자연 해소로 닫혀야"

                from sqlalchemy import select
                from app.models.chain_circuit_breaker import ChainCircuitBreaker
                row = (await s.execute(
                    select(ChainCircuitBreaker).where(ChainCircuitBreaker.conversation_id == conv_id)
                )).scalar_one()
                assert row.released_by is None
                assert row.release_reason.startswith("auto:")
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_release_circuit_breaker_realdb_idempotent():
    from app.services.chain_escalation import (
        evaluate_unsupervised_chain_episode, release_circuit_breaker, get_open_circuit_breaker_id,
    )

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_org_owner(s, org_id)
            agent_id = await _seed_agent(s, org_id, project_id)
            conv_id = await _seed_conversation(s, org_id, project_id)
            await _seed_messages(s, conv_id, agent_id, 20, ages_seconds=10)

            client = _fakeredis_client()
            with patch("app.services.redis_shared.get_client", return_value=client), \
                 patch("app.services.notification_dispatch.dispatch_notification", AsyncMock()):
                await evaluate_unsupervised_chain_episode(
                    s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                )

            releaser_id = uuid.uuid4()
            first = await release_circuit_breaker(
                s, conversation_id=conv_id, released_by=releaser_id, reason="사람이 확인함",
            )
            assert first is True
            assert await get_open_circuit_breaker_id(s, conv_id) is None

            second = await release_circuit_breaker(
                s, conversation_id=conv_id, released_by=uuid.uuid4(), reason="중복 클릭",
            )
            assert second is False, "이미 닫힌 서킷을 다시 닫으려는 호출은 no-op"
    finally:
        await engine.dispose()


# ─── send_message() 발신 차단 — agent만, human은 항상 통과 ────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_send_message_blocked_for_agent_when_breaker_open():
    from app.routers.conversations import SendMessageRequest, send_message
    from app.services.chain_escalation import _open_circuit_breaker

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            conv_id = await _seed_conversation(s, org_id, project_id)
            await _add_participant(s, conv_id, agent_id)
            await _open_circuit_breaker(s, org_id=org_id, conversation_id=conv_id, project_id=project_id)
            await s.commit()

            body = SendMessageRequest(content="폭주 재시도")
            with pytest.raises(HTTPException) as ei:
                await send_message(
                    conv_id, body, BackgroundTasks(), db=s,
                    auth=_agent_auth(agent_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 423
            assert ei.value.detail["error"] == "circuit_breaker_open"

            from sqlalchemy import select, func
            from app.models.conversation import ConversationMessage
            cnt = (await s.execute(
                select(func.count()).select_from(ConversationMessage).where(
                    ConversationMessage.conversation_id == conv_id, ConversationMessage.content == "폭주 재시도",
                )
            )).scalar_one()
            assert cnt == 0, "차단된 발신은 메시지로 남지 않는다"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_send_message_allows_human_even_when_breaker_open():
    """페드루 필수수정(2026-08-13): 서킷 open 대화에도 human 발신(개입)은 항상 통과."""
    from app.routers.conversations import SendMessageRequest, send_message
    from app.services.chain_escalation import _open_circuit_breaker

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            user_id, _om_id = await _seed_human(s, org_id, project_id, role="owner")
            conv_id = await _seed_conversation(s, org_id, project_id, conv_type="group")
            await _open_circuit_breaker(s, org_id=org_id, conversation_id=conv_id, project_id=project_id)
            await s.commit()

            body = SendMessageRequest(content="사람이 개입한다")
            resp = await send_message(
                conv_id, body, BackgroundTasks(), db=s,
                auth=_human_auth(user_id, org_id), org_id=org_id,
            )
            assert resp["data"]["content"] == "사람이 개입한다"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_send_message_allows_agent_when_no_breaker_open():
    """회귀0 — 서킷이 안 열린 정상 대화에선 agent 발신이 평소대로 통과."""
    from app.routers.conversations import SendMessageRequest, send_message

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            agent_id = await _seed_agent(s, org_id, project_id)
            conv_id = await _seed_conversation(s, org_id, project_id)
            await _add_participant(s, conv_id, agent_id)

            body = SendMessageRequest(content="평상 발신")
            resp = await send_message(
                conv_id, body, BackgroundTasks(), db=s,
                auth=_agent_auth(agent_id, org_id), org_id=org_id,
            )
            assert resp["data"]["content"] == "평상 발신"
    finally:
        await engine.dispose()


# ─── 해제 엔드포인트 — human org owner/admin 전용 ──────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_release_endpoint_requires_org_owner_admin():
    from app.routers.conversations import CircuitBreakerReleaseRequest, release_circuit_breaker_endpoint
    from app.services.chain_escalation import _open_circuit_breaker

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            member_user_id, _ = await _seed_human(s, org_id, project_id, role="member")  # owner/admin 아님
            conv_id = await _seed_conversation(s, org_id, project_id)
            await _open_circuit_breaker(s, org_id=org_id, conversation_id=conv_id, project_id=project_id)
            await s.commit()

            with pytest.raises(HTTPException) as ei:
                await release_circuit_breaker_endpoint(
                    conv_id, CircuitBreakerReleaseRequest(), db=s,
                    auth=_human_auth(member_user_id, org_id), org_id=org_id,
                )
            assert ei.value.status_code == 403
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_release_endpoint_owner_closes_breaker_idempotently():
    from app.routers.conversations import CircuitBreakerReleaseRequest, release_circuit_breaker_endpoint
    from app.services.chain_escalation import _open_circuit_breaker, get_open_circuit_breaker_id

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            owner_user_id, _ = await _seed_human(s, org_id, project_id, role="owner")
            conv_id = await _seed_conversation(s, org_id, project_id)
            await _open_circuit_breaker(s, org_id=org_id, conversation_id=conv_id, project_id=project_id)
            await s.commit()

            resp = await release_circuit_breaker_endpoint(
                conv_id, CircuitBreakerReleaseRequest(reason="확인 완료"), db=s,
                auth=_human_auth(owner_user_id, org_id), org_id=org_id,
            )
            assert resp["released"] is True
            assert await get_open_circuit_breaker_id(s, conv_id) is None

            resp2 = await release_circuit_breaker_endpoint(
                conv_id, CircuitBreakerReleaseRequest(), db=s,
                auth=_human_auth(owner_user_id, org_id), org_id=org_id,
            )
            assert resp2["released"] is False, "중복 해제 호출은 에러 없이 no-op"
    finally:
        await engine.dispose()
