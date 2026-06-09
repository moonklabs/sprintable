"""E-CHAT-CMD S1 AC1 real-DB: members.runtime_type 컬럼 마이그 + 모델 roundtrip + 무회귀.

마이그 0105 적용 DB 전제. (1) 컬럼 존재(nullable Text) (2) Member 모델로 agent runtime_type
write/read (3) 휴먼/미설정 NULL (4) team_members 뷰·기존 member read 무회귀.

DB env(PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL) 없으면 skip — CI alembic-fresh-db 잡에서 실행.
"""
from __future__ import annotations

import os
import uuid

import pytest

_RAW_URL = os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL") or ""
_ASYNC_URL = _RAW_URL.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _ASYNC_URL, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


ORG = uuid.UUID("e1660000-0000-0000-0000-000000000001")
U_HUMAN = uuid.UUID("e1660000-0000-0000-0000-0000000000b1")
M_HUMAN = uuid.UUID("e1660000-0000-0000-0000-0000000000c1")
M_AGENT = uuid.UUID("e1660000-0000-0000-0000-0000000000e1")


async def _seed(session):
    from sqlalchemy import text

    stmts = [
        f"DELETE FROM members WHERE org_id = '{ORG}'",
        f"DELETE FROM users WHERE id = '{U_HUMAN}'",
        f"DELETE FROM organizations WHERE id = '{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','E166','e166org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count) "
        f"VALUES ('{U_HUMAN}','h@e166.test','x','H',true,true,0,false,0)",
    ]
    for s in stmts:
        await session.execute(text(s))
    await session.commit()


@pytest.mark.anyio
async def test_runtime_type_column_exists_and_nullable():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            row = (await s.execute(text(
                "SELECT data_type, is_nullable FROM information_schema.columns "
                "WHERE table_name='members' AND column_name='runtime_type'"
            ))).first()
        assert row is not None, "members.runtime_type 컬럼 미존재(마이그 0105 미적용)"
        assert row[0] == "text", f"runtime_type 타입 text 아님: {row[0]}"
        assert row[1] == "YES", "runtime_type nullable 아님"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_member_model_runtime_type_roundtrip_and_human_null():
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.models.member import Member

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            # 에이전트: runtime_type 설정
            s.add(Member(id=M_AGENT, org_id=ORG, type="agent", name="HermesBot",
                         owner_member_id=None, runtime_type="hermes"))
            # 휴먼: runtime_type 미설정(NULL)
            s.add(Member(id=M_HUMAN, org_id=ORG, type="human", user_id=U_HUMAN, name="H"))
            await s.commit()

        async with Session() as s:
            agent = (await s.execute(select(Member).where(Member.id == M_AGENT))).scalar_one()
            human = (await s.execute(select(Member).where(Member.id == M_HUMAN))).scalar_one()
        assert agent.runtime_type == "hermes", f"agent runtime_type roundtrip 실패: {agent.runtime_type}"
        assert human.runtime_type is None, f"휴먼 runtime_type NULL 아님: {human.runtime_type}"

        # capability lookup 연동(끝단 정합): hermes=결정적 지원, 휴먼(None)=미지원
        from app.services.agent_runtime import supports_deterministic_command
        assert supports_deterministic_command(agent.runtime_type) is True
        assert supports_deterministic_command(human.runtime_type) is False
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_team_members_view_unaffected_by_column_add():
    """무회귀: members 컬럼 추가가 의존 뷰 team_members 를 깨지 않음 — agent 행 정상 조회."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            # 뷰가 살아있고 SELECT 가능한지(컬럼 추가 후 뷰 무손상)
            await s.execute(text("SELECT id, type, name FROM team_members LIMIT 1"))
            relkind = (await s.execute(text(
                "SELECT relkind::text FROM pg_class WHERE relname='team_members'"))).scalar()
        # relkind 'v' = view (asyncpg char 타입은 bytes 로 올 수 있어 ::text 캐스트)
        assert relkind == "v", f"team_members 뷰 손상: relkind={relkind!r}"
    finally:
        await engine.dispose()
