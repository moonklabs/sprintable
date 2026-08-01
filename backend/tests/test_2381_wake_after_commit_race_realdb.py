"""story #2381 — wake_agent()이 commit 前에 발화되면 수신자가 아직 그 Event row를 못 보는
레이스를 실제로 재현해 보인 뒤(AC3: "재현 없이 «이렇게 하면 안전하다»로 넘어가지 않는다"),
고친 뒤 그 레이스가 구조적으로 사라지는 것까지 같은 파일에서 보인다.

배경: dispatch_notification()의 agent-recipient Event 생성 경로는 지금까지 어디서도
wake_agent()를 부르지 않았다(이 스토리의 근본 — /stream은 wake 신호가 큐에 와야 DB를
재조회하므로, 연결 中인 에이전트도 다음 재연결까지 새 이벤트를 몰랐다). event_seq.py의
assign_recipient_seq()에 "commit 성공 後에만" wake_agent()가 자동 발화되도록 예약을 걸어
고쳤다 — 호출부(dispatch_notification()의 ~20곳, 현재도 미래도)가 wake를 기억해서 불러야
한다는 조건부 계약을 추가하는 대신, agent Event 가시성의 유일한 관문(#2375가 세운 불변식)에
자동으로 묶어 "부르는 것을 잊으면 재발한다"는 조건 자체를 없앴다(AC2).

실 PG 필요 — MVCC 가시성(별개 커넥션 간 실제 트랜잭션 격리)은 mock으로도 SQLite로도 재현
불가능하다. 이 파일 자체가 그 격리를 증명 대상으로 삼는다.
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# story 8236bbc3: create_all로 자체 스키마를 직접 다룸 — 격리 DB 전용(conftest.py 가드).
pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _asyncpg_url(url: str) -> str:
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


def _raw_url(url: str) -> str:
    """asyncpg.connect()가 받는 순수 postgresql:// (SQLAlchemy 드라이버 접미사 제거)."""
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://"):
        if url.startswith(prefix):
            return "postgresql://" + url[len(prefix):]
    return url


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.event  # noqa: F401
    engine = create_async_engine(_asyncpg_url(_REAL_DB_URL))
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org_project_agent(s):
    from app.models.project import Project
    from app.models.team import TeamMember

    org, proj = uuid.uuid4(), uuid.uuid4()
    s.add(Project(id=proj, org_id=org, name="p"))
    await s.flush()
    agent = TeamMember(
        id=uuid.uuid4(), org_id=org, project_id=proj, type="agent",
        name="agent", role="member", is_active=True,
    )
    s.add(agent)
    await s.flush()
    await s.commit()
    return org, proj, agent.id


async def _visible_recipient_seq_count(raw_url: str, recipient_id: uuid.UUID, after_seq: int) -> int:
    """agent_gateway.py `_fetch_events`의 커서 조건(recipient_seq > after_seq)과 동일 — 별개
    (raw asyncpg) 커넥션에서 조회해 진짜 cross-transaction MVCC 가시성을 잰다. 같은 세션 내
    조회는 flush만으로도 보여 이 레이스를 재현하지 못한다."""
    import asyncpg
    conn = await asyncpg.connect(raw_url)
    try:
        return int(await conn.fetchval(
            "SELECT count(*) FROM events WHERE recipient_id = $1 AND recipient_seq > $2",
            recipient_id, after_seq,
        ))
    finally:
        await conn.close()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_race_reproduced_wake_before_commit_sees_invisible_row():
    """AC3 재현: commit 前에 "wake"(=다른 커넥션이 재조회하라는 신호)가 나가면, 바로 그 순간
    다른 커넥션이 같은 커서 쿼리를 돌려도 0건이다 — "깨웠지만 아직 아무것도 없다"는 헛걸음이
    실제로 존재함을, 구식(commit 前 발화) 패턴으로 직접 재현한다. event_seq.py의 새 자동예약과
    무관하게, "commit 前 wake"라는 패턴 자체가 왜 위험한지를 독립적으로 증명하는 대조군."""
    raw_url = _raw_url(_asyncpg_url(_REAL_DB_URL))
    engine, Session = await _session()
    try:
        async with Session() as seed_s:
            org, proj, agent_id = await _seed_org_project_agent(seed_s)

        from app.models.event import Event
        from app.services.event_seq import assign_recipient_seq

        async with Session() as s:
            event = Event(
                project_id=proj, org_id=org, event_type="dispatched",
                recipient_id=agent_id, recipient_type="agent",
                payload={"content": "x"}, status="pending",
            )
            s.add(event)
            await s.flush()
            seq = await assign_recipient_seq(s, event)

            # ⛔구식 패턴 재현: commit 前에 wake 신호(=다른 커넥션의 재조회)가 이미 도착했다고 가정.
            visible_before_commit = await _visible_recipient_seq_count(raw_url, agent_id, seq - 1)
            assert visible_before_commit == 0, (
                "레이스가 재현되지 않았다 — commit 前인데 다른 커넥션에 row가 보인다면 "
                "이 테스트의 전제(MVCC 격리)가 깨진 것이다"
            )

            await s.commit()

            visible_after_commit = await _visible_recipient_seq_count(raw_url, agent_id, seq - 1)
            assert visible_after_commit == 1, "commit 後에는 반드시 보여야 한다"
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_fix_wake_fires_only_after_commit_and_row_already_visible_by_then(monkeypatch):
    """고친 뒤: assign_recipient_seq()가 예약한 wake는 db.commit() 호출 안에서(반환 전에) 정확히
    한 번 발화되고, 그 발화 시점엔 이미 다른 커넥션에서도 row가 보인다 — 위 대조군이 재현한
    레이스가 이 경로에서는 구조적으로 성립할 수 없음을 보인다(재현 후 소거, AC3 요구)."""
    raw_url = _raw_url(_asyncpg_url(_REAL_DB_URL))
    engine, Session = await _session()
    try:
        async with Session() as seed_s:
            org, proj, agent_id = await _seed_org_project_agent(seed_s)

        from app.models.event import Event
        from app.services.event_seq import assign_recipient_seq
        import app.routers.agent_gateway as gw_mod

        woken: list[tuple[str, int]] = []
        monkeypatch.setattr(gw_mod, "wake_agent", lambda rid, seq: woken.append((rid, seq)))
        # event_seq._fire_pending_wakes는 `from app.routers.agent_gateway import wake_agent`를
        # 발화 시점에 매번 late-import하므로, gw_mod 속성을 바꾸는 것만으로 monkeypatch가 반영된다.

        async with Session() as s:
            event = Event(
                project_id=proj, org_id=org, event_type="dispatched",
                recipient_id=agent_id, recipient_type="agent",
                payload={"content": "x"}, status="pending",
            )
            s.add(event)
            await s.flush()
            seq = await assign_recipient_seq(s, event)

            assert woken == [], "commit 前인데 이미 wake가 발화됐다 — 레이스 재발"

            await s.commit()

        assert woken == [(str(agent_id), seq)], f"commit 後 정확히 한 번 발화돼야 하는데: {woken}"

        visible = await _visible_recipient_seq_count(raw_url, agent_id, seq - 1)
        assert visible == 1
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_rollback_never_fires_wake(monkeypatch):
    """seq 발급 트랜잭션이 rollback되면 wake는 절대 발화되지 않아야 한다(존재하지 않게 될 row를
    가리키는 헛된 wake 방지)."""
    engine, Session = await _session()
    try:
        async with Session() as seed_s:
            org, proj, agent_id = await _seed_org_project_agent(seed_s)

        from app.models.event import Event
        from app.services.event_seq import assign_recipient_seq
        import app.routers.agent_gateway as gw_mod

        woken: list[tuple[str, int]] = []
        monkeypatch.setattr(gw_mod, "wake_agent", lambda rid, seq: woken.append((rid, seq)))

        async with Session() as s:
            event = Event(
                project_id=proj, org_id=org, event_type="dispatched",
                recipient_id=agent_id, recipient_type="agent",
                payload={"content": "x"}, status="pending",
            )
            s.add(event)
            await s.flush()
            await assign_recipient_seq(s, event)
            await s.rollback()

        assert woken == []
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_multiple_dispatches_same_session_each_wake_exactly_once(monkeypatch):
    """한 세션에서 여러 번 commit(=여러 dispatch)해도 매번 그 트랜잭션분만 정확히 한 번씩
    발화한다 — 세션 재사용 시 리스너 중복등록(이중발화)도, 예약 누락(무발화)도 없어야 한다."""
    engine, Session = await _session()
    try:
        async with Session() as seed_s:
            org, proj, agent_id = await _seed_org_project_agent(seed_s)

        from app.models.event import Event
        from app.services.event_seq import assign_recipient_seq
        import app.routers.agent_gateway as gw_mod

        woken: list[tuple[str, int]] = []
        monkeypatch.setattr(gw_mod, "wake_agent", lambda rid, seq: woken.append((rid, seq)))

        async with Session() as s:
            seqs = []
            for _ in range(3):
                event = Event(
                    project_id=proj, org_id=org, event_type="dispatched",
                    recipient_id=agent_id, recipient_type="agent",
                    payload={"content": "x"}, status="pending",
                )
                s.add(event)
                await s.flush()
                seqs.append(await assign_recipient_seq(s, event))
                await s.commit()

        assert woken == [(str(agent_id), seq) for seq in seqs]
    finally:
        await engine.dispose()
