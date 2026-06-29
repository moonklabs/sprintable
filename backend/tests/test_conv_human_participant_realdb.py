"""e6f25e53 (산티아고 SME 권고): `_conversation_has_human_participant` 보수성 **실 view** 락.

cp2(test_chat_visibility_admin_bypass)는 team_members 쿼리를 mock 해 helper set-logic 만 검증한다.
이건 실 team_members VIEW(members⋈agent_project_profiles)로 락: agent(뷰 출현) + grant-only/미앵커 휴먼
(team_members agent 미확정) 섞이면 human=True(보수적), agent-only 면 False. DB env 없으면 skip(CI alembic-fresh).
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("e6000000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("e6000000-0000-0000-0000-0000000000c1")
AGENT = uuid.UUID("e6000000-0000-0000-0000-0000000000a1")
AGENT2 = uuid.UUID("e6000000-0000-0000-0000-0000000000a2")
HUMAN_UNANCHORED = uuid.UUID("e6000000-0000-0000-0000-0000000000b9")  # team_members agent 미확정(grant-only/미앵커)


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _seed(s):
    for sql in [
        f"DELETE FROM conversation_participants WHERE member_id IN ('{AGENT}','{AGENT2}','{HUMAN_UNANCHORED}')",
        f"DELETE FROM conversations WHERE org_id='{ORG}'",
        f"DELETE FROM agent_project_profiles WHERE member_id IN ('{AGENT}','{AGENT2}')",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','E6','e6org','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P')",
        "INSERT INTO members (id,org_id,type,name,is_active) VALUES "
        f"('{AGENT}','{ORG}','agent','Bot1',true),('{AGENT2}','{ORG}','agent','Bot2',true)",
        # 에이전트 team_members 뷰 출현(agent_project_profiles join).
        "INSERT INTO agent_project_profiles (id,member_id,project_id,agent_role,fakechat_port) VALUES "
        f"(gen_random_uuid(),'{AGENT}','{PROJ}','dev',9701),(gen_random_uuid(),'{AGENT2}','{PROJ}','dev',9702)",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _conv_with(s, conv_id, member_ids):
    await s.execute(text(
        f"INSERT INTO conversations (id,project_id,org_id,type,created_by) "
        f"VALUES ('{conv_id}','{PROJ}','{ORG}','group','{AGENT}')"
    ))
    for m in member_ids:
        await s.execute(text(
            "INSERT INTO conversation_participants (id,conversation_id,member_id) "
            f"VALUES (gen_random_uuid(),'{conv_id}','{m}')"
        ))
    await s.commit()


@pytest.mark.anyio
async def test_helper_conservatism_real_view():
    from app.routers.conversations import _conversation_has_human_participant

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            # ① agent(뷰 출현) + 미앵커 휴먼(agent 미확정) → 보수적 human=True (산티아고 케이스).
            mixed = uuid.uuid4()
            await _conv_with(s, mixed, [AGENT, HUMAN_UNANCHORED])
            assert await _conversation_has_human_participant(mixed, s) is True
            # ② agent-only(둘 다 뷰 agent) → False.
            agent_only = uuid.uuid4()
            await _conv_with(s, agent_only, [AGENT, AGENT2])
            assert await _conversation_has_human_participant(agent_only, s) is False
    finally:
        await engine.dispose()
