"""story #2626: 무감독 연쇄 알림 재설계 — 속도 기반 이상 에피소드.

원 게이트 조건(#2617, depth > cap)이 human-less 대화에서 영구 참인 상시 상태라 24h dedup
으로도 알림 폭주를 못 막았다(#3016 진단·킬스위치). 이 파일은 그 트리거를 대체한
`evaluate_unsupervised_chain_episode`(chain_escalation.py)의 에피소드 상태기계를 검증한다:
- AC1: 정상 fleet 속도(임계 이하)에서는 몇 메시지가 오가도 알림 0.
- AC2: 폭주(임계 초과) 진입 시 1회만 발화 — 같은 에피소드 진행 중 재발화 없음.
- AC3: 해소(임계 이하로 복귀) 후 재폭주만 재발화 — 상시 재통보 금지.
- TTL: 마커에 TTL이 걸려 침묵으로 에피소드가 끝나도(해소를 평가할 다음 메시지가 안 옴)
  자연 소멸한다(PO 필수 조건 — stale 마커가 다음 폭주를 영구 억제하는 결함 방지).
- org 설정 표면: `chain_escalation_org_config` 행으로 임계/창/enabled를 org별 오버라이드.
- 15분 플래핑 쿨다운: 에피소드가 빠르게 여닫혀도 실 알림은 쿨다운 창당 최대 1건.
- Redis 다운 fail-closed(#2617 PO 조건(a) 계승).

`_conversation_has_human`(channel_router.py, #2617에서 검증) 자체는 #2626이 안 건드려
test_2617_chain_escalation.py에 그대로 남아 있다.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest

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

    org = Organization(id=uuid.uuid4(), name="Org2626", slug=f"org2626-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    project = Project(id=uuid.uuid4(), org_id=org.id, name="P")
    session.add(project)
    await session.commit()
    return org.id, project.id


async def _seed_member(session, org_id, project_id, *, member_type="agent"):
    from app.models.team import TeamMember

    m = TeamMember(
        id=uuid.uuid4(), org_id=org_id, project_id=project_id, type=member_type,
        name=member_type, is_active=True,
    )
    session.add(m)
    await session.commit()
    return m.id


async def _seed_conversation(session, org_id, project_id, *, conv_type="group"):
    from app.models.conversation import Conversation

    conv = Conversation(id=uuid.uuid4(), org_id=org_id, project_id=project_id, type=conv_type)
    session.add(conv)
    await session.commit()
    return conv.id


async def _seed_org_owner(session, org_id, *, role="owner"):
    from app.models.project import OrgMember

    om = OrgMember(id=uuid.uuid4(), org_id=org_id, user_id=uuid.uuid4(), role=role)
    session.add(om)
    await session.commit()
    return om.id


async def _seed_messages(session, conversation_id, sender_id, count, *, ages_seconds=0):
    """`count`개 메시지를 이 대화에 만든다 — 전부 지금으로부터 `ages_seconds`초 전 시각으로
    스탬프(속도 윈도우 안/밖 시뮬레이션용, TimestampMixin의 server_default를 명시값으로 override)."""
    from app.models.conversation import ConversationMessage

    ts = datetime.now(timezone.utc) - timedelta(seconds=ages_seconds)
    for _ in range(count):
        session.add(ConversationMessage(
            id=uuid.uuid4(), conversation_id=conversation_id, sender_id=sender_id,
            content="msg", created_at=ts,
        ))
    await session.commit()


async def _seed_org_config(session, org_id, *, enabled=True, window_seconds=300, threshold=15):
    from app.models.chain_escalation_org_config import ChainEscalationOrgConfig

    session.add(ChainEscalationOrgConfig(
        id=uuid.uuid4(), org_id=org_id, enabled=enabled,
        window_seconds=window_seconds, threshold=threshold,
    ))
    await session.commit()


def _fakeredis_client():
    aioredis = pytest.importorskip("fakeredis.aioredis")
    server = aioredis.FakeServer()
    return aioredis.FakeRedis(server=server, decode_responses=True)


# ─── AC1: 정상 fleet 속도 — 알림 0 ─────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_ac1_normal_velocity_never_notifies():
    """실측 근거(p99=8/5분) 이하인 5건/5분 — 임계 15 미만이라 여러 번 평가해도 알림 0."""
    from app.services.chain_escalation import evaluate_unsupervised_chain_episode

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_org_owner(s, org_id, role="owner")
            agent_id = await _seed_member(s, org_id, project_id)
            conv_id = await _seed_conversation(s, org_id, project_id)
            await _seed_messages(s, conv_id, agent_id, 5, ages_seconds=30)  # 5건, 임계(15) 미만

            client = _fakeredis_client()
            dn = AsyncMock()
            with patch("app.services.redis_shared.get_client", return_value=client), \
                 patch("app.services.notification_dispatch.dispatch_notification", dn):
                for _ in range(10):  # 여러 메시지 평가를 시뮬레이션
                    await evaluate_unsupervised_chain_episode(
                        s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                    )
                dn.assert_not_awaited()
    finally:
        await engine.dispose()


# ─── AC2: 폭주 진입 1회 발화, 진행 중 재발화 없음 ───────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_ac2_burst_fires_once_no_refire_while_continuing():
    from app.services.chain_escalation import evaluate_unsupervised_chain_episode

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            owner_id = await _seed_org_owner(s, org_id, role="owner")
            agent_id = await _seed_member(s, org_id, project_id)
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
                assert kw["target_member_ids"] == [owner_id]
                assert kw["event_type"] == "conversation.unsupervised_chain_expired"

                # 같은 에피소드 진행 중(여전히 폭주 상태) — 재평가해도 재발화 없음.
                await evaluate_unsupervised_chain_episode(
                    s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                )
                await evaluate_unsupervised_chain_episode(
                    s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                )
                dn.assert_awaited_once(), "같은 에피소드 진행 중엔 재발화 금지"
    finally:
        await engine.dispose()


# ─── AC3: 해소 후 재폭주만 재발화 ───────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_ac3_resolve_then_reburst_refires():
    """해소(임계 이하로 복귀) 평가 — 무알림 clear. 그 다음 재폭주만 새 에피소드로 재발화.

    이 테스트는 에피소드 마커의 resolve→refire 메커니즘 자체를 격리 검증한다 — 15분
    플래핑 쿨다운(별도 축, test_flap_cooldown_*가 검증)은 실제로는 이 짧은 재발화 간격도
    억제할 것이므로(의도된 동작, 플래핑 방지가 AC3보다 우선) 여기서는 쿨다운 클레임을
    항상 성공으로 고정해 마커 상태기계만 본다."""
    from app.services.chain_escalation import evaluate_unsupervised_chain_episode

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_org_owner(s, org_id, role="owner")
            agent_id = await _seed_member(s, org_id, project_id)
            conv_burst = await _seed_conversation(s, org_id, project_id)
            await _seed_messages(s, conv_burst, agent_id, 20, ages_seconds=10)

            client = _fakeredis_client()
            dn = AsyncMock()
            with patch("app.services.redis_shared.get_client", return_value=client), \
                 patch("app.services.notification_dispatch.dispatch_notification", dn), \
                 patch("app.services.chain_escalation._claim_flap_cooldown_slot", return_value=True):
                await evaluate_unsupervised_chain_episode(
                    s, org_id=org_id, conversation_id=conv_burst, project_id=project_id,
                )
                dn.assert_awaited_once()

                # 해소 — 다음 평가 시점엔 이 conv의 최근 메시지가 창 밖(오래됨)이라 속도 0.
                # 새 conversation_id로 "해소된 대화"를 시뮬레이션(같은 conv_id 재사용 시
                # 이미 심은 20건이 계속 카운트돼 해소를 못 만든다 — 별도 conv로 클린 해소).
                conv_resolved_key = conv_burst  # 마커는 conv_id 키니 같은 키로 낮은 속도 평가.

                async def _low_velocity(db, conversation_id, window_seconds):  # noqa: ARG001
                    return 2  # 임계(15) 미만

                with patch(
                    "app.services.chain_escalation._recent_message_velocity",
                    side_effect=_low_velocity,
                ):
                    await evaluate_unsupervised_chain_episode(
                        s, org_id=org_id, conversation_id=conv_resolved_key, project_id=project_id,
                    )
                dn.assert_awaited_once(), "해소 평가 자체는 무알림(clear만)"

                # 재폭주 — 마커가 해소로 지워졌으니 새 에피소드로 재발화.
                await evaluate_unsupervised_chain_episode(
                    s, org_id=org_id, conversation_id=conv_burst, project_id=project_id,
                )
                assert dn.await_count == 2, "해소 후 재폭주는 새 에피소드로 재발화돼야"
    finally:
        await engine.dispose()


# ─── TTL: 침묵 종료도 자연 소멸(stale 마커가 다음 폭주를 영구 억제하면 안 됨) ──────

@pytest.mark.anyio
async def test_episode_marker_ttl_set_and_refreshed():
    """마커 생성 시 TTL=window*2, 재평가(진행 중)마다 TTL 갱신 — 침묵(다음 평가가 영영 안
    옴)이어도 TTL이 지나면 Redis가 자연 소멸시켜 다음 폭주 알림을 억제하지 않는다."""
    from app.services.chain_escalation import _evaluate_episode_marker

    client = _fakeredis_client()
    conv_id = uuid.uuid4()
    with patch("app.services.redis_shared.get_client", return_value=client):
        state = await _evaluate_episode_marker(conv_id, above_threshold=True, ttl_seconds=600)
        assert state == "started"

        from app.services import redis_shared
        key = redis_shared.key("chain_escalation", "episode", str(conv_id))
        ttl1 = await client.ttl(key)
        assert 0 < ttl1 <= 600, "새 마커는 TTL이 걸려 있어야(침묵 시 자연 소멸)"

        # 진행 중 재평가 — TTL이 갱신(리셋)돼야 폭주가 계속되는 동안은 안 죽는다.
        state2 = await _evaluate_episode_marker(conv_id, above_threshold=True, ttl_seconds=600)
        assert state2 == "continuing"
        ttl2 = await client.ttl(key)
        assert ttl2 > 0


@pytest.mark.anyio
async def test_episode_marker_resolved_deletes_key_idle_when_absent():
    from app.services.chain_escalation import _evaluate_episode_marker

    client = _fakeredis_client()
    conv_id = uuid.uuid4()
    with patch("app.services.redis_shared.get_client", return_value=client):
        assert await _evaluate_episode_marker(conv_id, above_threshold=False, ttl_seconds=600) == "idle"
        assert await _evaluate_episode_marker(conv_id, above_threshold=True, ttl_seconds=600) == "started"
        assert await _evaluate_episode_marker(conv_id, above_threshold=False, ttl_seconds=600) == "resolved"
        assert await _evaluate_episode_marker(conv_id, above_threshold=False, ttl_seconds=600) == "idle"


# ─── org 설정 표면 ──────────────────────────────────────────────────────────────

@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_org_config_disabled_suppresses_even_above_default_threshold():
    from app.services.chain_escalation import evaluate_unsupervised_chain_episode

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_org_owner(s, org_id, role="owner")
            agent_id = await _seed_member(s, org_id, project_id)
            conv_id = await _seed_conversation(s, org_id, project_id)
            await _seed_messages(s, conv_id, agent_id, 50, ages_seconds=10)  # 명백한 폭주
            await _seed_org_config(s, org_id, enabled=False)

            client = _fakeredis_client()
            dn = AsyncMock()
            with patch("app.services.redis_shared.get_client", return_value=client), \
                 patch("app.services.notification_dispatch.dispatch_notification", dn):
                await evaluate_unsupervised_chain_episode(
                    s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                )
                dn.assert_not_awaited(), "org enabled=False면 임계 초과여도 무발화"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_org_config_custom_threshold_overrides_default():
    """org별 threshold=3으로 낮추면, 기본값(15)에서는 정상이었을 5건도 폭주로 판정."""
    from app.services.chain_escalation import evaluate_unsupervised_chain_episode

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id, project_id = await _seed_org_project(s)
            await _seed_org_owner(s, org_id, role="owner")
            agent_id = await _seed_member(s, org_id, project_id)
            conv_id = await _seed_conversation(s, org_id, project_id)
            await _seed_messages(s, conv_id, agent_id, 5, ages_seconds=10)
            await _seed_org_config(s, org_id, enabled=True, window_seconds=300, threshold=3)

            client = _fakeredis_client()
            dn = AsyncMock()
            with patch("app.services.redis_shared.get_client", return_value=client), \
                 patch("app.services.notification_dispatch.dispatch_notification", dn):
                await evaluate_unsupervised_chain_episode(
                    s, org_id=org_id, conversation_id=conv_id, project_id=project_id,
                )
                dn.assert_awaited_once(), "org 임계를 3으로 낮추면 5건도 폭주로 잡혀야"
    finally:
        await engine.dispose()


# ─── 15분 플래핑 쿨다운 ─────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_flap_cooldown_blocks_rapid_reflare_but_marker_still_tracks():
    """같은 15분 창 안 두 번째 «새 에피소드»(해소→재폭주 플래핑)는 마커는 정상 갱신되지만
    실 알림은 쿨다운에 막힌다 — 플래핑이 알림 폭주로 안 새는 안전망."""
    from app.services.chain_escalation import _claim_flap_cooldown_slot

    client = _fakeredis_client()
    conv_id = uuid.uuid4()
    with patch("app.services.redis_shared.get_client", return_value=client):
        assert await _claim_flap_cooldown_slot(conv_id) is True, "첫 클레임은 성공"
        assert await _claim_flap_cooldown_slot(conv_id) is False, "쿨다운 중 재클레임은 실패"

        other_conv = uuid.uuid4()
        assert await _claim_flap_cooldown_slot(other_conv) is True, "쿨다운 키는 대화별 독립"


# ─── Redis 다운 fail-closed ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_redis_down_fails_closed_no_notification():
    from app.services.chain_escalation import evaluate_unsupervised_chain_episode

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=RuntimeError("should not query DB before redis check matters"))
    dn = AsyncMock()

    async def _fake_get_org_config(db, org_id):  # noqa: ARG001
        return True, 300, 15

    async def _fake_velocity(db, conversation_id, window_seconds):  # noqa: ARG001
        return 999  # 명백한 폭주

    with patch("app.services.redis_shared.get_client", return_value=None), \
         patch("app.services.notification_dispatch.dispatch_notification", dn), \
         patch("app.services.chain_escalation._get_org_config", side_effect=_fake_get_org_config), \
         patch("app.services.chain_escalation._recent_message_velocity", side_effect=_fake_velocity):
        await evaluate_unsupervised_chain_episode(
            session, org_id=uuid.uuid4(), conversation_id=uuid.uuid4(), project_id=uuid.uuid4(),
        )
    dn.assert_not_awaited()


@pytest.mark.anyio
async def test_swallows_exceptions_best_effort():
    """알림 경로 예외는 메시지 발신을 막지 않는다 — best-effort(다른 doc.py 알림 경로와 동형)."""
    from app.services.chain_escalation import evaluate_unsupervised_chain_episode

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=RuntimeError("boom"))
    await evaluate_unsupervised_chain_episode(
        session, org_id=uuid.uuid4(), conversation_id=uuid.uuid4(), project_id=uuid.uuid4(),
    )  # 예외 전파 없이 조용히 반환
