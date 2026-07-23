"""story #2139(2026-07-23) done-gate 정정 — presence(`push_to_org_members(member_ids=None)`)의
org-wide 수신자 해소가 실제 org 구성(휴먼+에이전트) 데이터 모양 그대로 도달하는지 실DB로 고정.

배경(오르테가 검수 재지적): 이전 SQL은 `org_members`만 SELECT했다. 그 테이블은
`user_id NOT NULL`(휴먼 전용) — 에이전트는 애초에 그 테이블에 행이 없어 presence가 절대
도달하지 않았다(선언 "org 전체" vs 실제 "휴먼만"의 괴리, 라이브 실측으로 확認). 이 테스트는
그 실 데이터 모양(에이전트=members만·정상 휴먼=양쪽·미백필 스트래글러 휴먼=org_members만)을
그대로 재현한 채로 세 부류 전부가 실제로 도달하는지 검증한다 — mock으로 가리면 이 갭을 또
못 잡는다(오르테가 지적 그대로).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


@pytest.mark.anyio
async def test_presence_reaches_agent_synced_human_and_unbackfilled_straggler_human():
    """org 전체(휴먼+에이전트) 실 데이터 모양 그대로 세 부류 전부 push_to_org_members(None) 대상에
    포함되는지 확認 — mock 아닌 실 PG로 team_members_sync_gap 스트래글러까지 커버."""
    import asyncpg
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.routers.events import _agent_connections, push_to_org_members

    conn = await asyncpg.connect(_async_url().replace("postgresql+asyncpg://", "postgresql://"))
    org_id = uuid.uuid4()

    agent_id = uuid.uuid4()  # 순수 에이전트 — members만, org_members 행 자체가 없음(현실 그대로).
    synced_human_id = uuid.uuid4()  # 정상 휴먼 — members.id == org_members.id(E-MEMBER-SSOT 앵커).
    straggler_user_id = uuid.uuid4()
    straggler_org_member_id = uuid.uuid4()  # members_sync_gap 재현 — org_members만, members 없음.

    try:
        await conn.execute(
            "INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)",
            org_id, f"org-{org_id}", f"org-slug-{org_id}",
        )

        # 에이전트 — members만.
        await conn.execute(
            """INSERT INTO members (id, org_id, type, name)
               VALUES ($1, $2, 'agent', 'Agent')""",
            agent_id, org_id,
        )

        # 정상 휴먼 — users + org_members + members(앵커, id 동일) 전부.
        await conn.execute(
            "INSERT INTO users (id, email, hashed_password, email_verified) VALUES ($1, $2, 'x', true)",
            synced_human_id, f"synced-{synced_human_id}@test.com",
        )
        await conn.execute(
            "INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'member')",
            synced_human_id, org_id, synced_human_id,
        )
        await conn.execute(
            "INSERT INTO members (id, org_id, type, user_id, name) VALUES ($1, $2, 'human', $3, 'Synced Human')",
            synced_human_id, org_id, synced_human_id,
        )

        # 미백필 스트래글러 휴먼 — org_members만(members_sync_gap 재현, org-create/invite-accept
        # 직후 시점 시뮬 — members 앵커 행이 아직 없음).
        await conn.execute(
            "INSERT INTO users (id, email, hashed_password, email_verified) VALUES ($1, $2, 'x', true)",
            straggler_user_id, f"straggler-{straggler_user_id}@test.com",
        )
        await conn.execute(
            "INSERT INTO org_members (id, org_id, user_id, role) VALUES ($1, $2, $3, 'member')",
            straggler_org_member_id, org_id, straggler_user_id,
        )

        engine = create_async_engine(_async_url())
        Session = async_sessionmaker(engine, expire_on_commit=False)

        import contextlib

        @contextlib.asynccontextmanager
        async def _factory():
            async with Session() as s:
                yield s

        import asyncio
        import unittest.mock

        q_agent = asyncio.Queue()
        q_synced = asyncio.Queue()
        q_straggler = asyncio.Queue()
        _agent_connections[str(agent_id)].add(q_agent)
        _agent_connections[str(synced_human_id)].add(q_synced)
        _agent_connections[str(straggler_org_member_id)].add(q_straggler)

        with unittest.mock.patch("app.core.database.async_session_factory", _factory), \
             unittest.mock.patch("app.services.event_broker.event_broker.publish",
                                 new=unittest.mock.AsyncMock()):
            await push_to_org_members(str(org_id), "presence", {})

        assert not q_agent.empty(), "에이전트(members만) 에게 presence 미도달 — org_members-only 회귀"
        assert not q_synced.empty(), "정상 휴먼에게 presence 미도달"
        assert not q_straggler.empty(), (
            "members_sync_gap 스트래글러 휴먼에게 presence 미도달 — members로만 바꾸면 생기는 회귀"
        )
        assert q_agent.get_nowait()["event_type"] == "presence"
        assert q_synced.get_nowait()["event_type"] == "presence"
        assert q_straggler.get_nowait()["event_type"] == "presence"

        await engine.dispose()

    finally:
        cleanup = await asyncpg.connect(_async_url().replace("postgresql+asyncpg://", "postgresql://"))
        try:
            await cleanup.execute("DELETE FROM members WHERE org_id = $1", org_id)
            await cleanup.execute("DELETE FROM org_members WHERE org_id = $1", org_id)
            await cleanup.execute(
                "DELETE FROM users WHERE id = ANY($1::uuid[])",
                [synced_human_id, straggler_user_id],
            )
            await cleanup.execute("DELETE FROM organizations WHERE id = $1", org_id)
        except Exception:
            pass
        await cleanup.close()
        await conn.close()
        for mid in (str(agent_id), str(synced_human_id), str(straggler_org_member_id)):
            _agent_connections.pop(mid, None)
