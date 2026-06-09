"""E-CHAT-CMD S4 real-DB: capability gate — 미지원 런타임 에이전트에 커맨드 주입 차단.

마이그 0106(team_members 뷰 runtime_type 노출) 적용 DB 전제. `_command_capability_gate` 직접 검증:
- AC1: command candidate → 에이전트 수신자 runtime_type → capability lookup
- AC2: 지원(hermes) → 차단 안 함(pass-through)
- AC3: 미지원(claude-code) → 차단 + audit log `command_blocked_unsupported_runtime`
- AC4: runtime_type 없음(NULL) → 미지원 처리(차단). 비-command → 무게이트(회귀)

DB env 없으면 skip — CI alembic-fresh-db 잡에서 실행.
"""
from __future__ import annotations

import os
import types
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


ORG = uuid.UUID("a4000000-0000-0000-0000-000000000001")
P1 = uuid.UUID("a4000000-0000-0000-0000-0000000000a1")
CONV = uuid.UUID("a4000000-0000-0000-0000-0000000000d1")
SENDER = uuid.UUID("a4000000-0000-0000-0000-0000000000f1")  # human sender(member)
AG_OK = uuid.UUID("a4000000-0000-0000-0000-0000000000e1")   # hermes — 지원
AG_NO = uuid.UUID("a4000000-0000-0000-0000-0000000000e2")   # claude-code — 미지원
AG_NULL = uuid.UUID("a4000000-0000-0000-0000-0000000000e3")  # runtime_type NULL — 미지원


async def _seed(session):
    from sqlalchemy import text

    stmts = [
        f"DELETE FROM agent_audit_logs WHERE org_id='{ORG}'",
        f"DELETE FROM conversation_participants WHERE conversation_id='{CONV}'",
        f"DELETE FROM conversation_messages WHERE conversation_id='{CONV}'",
        f"DELETE FROM conversations WHERE id='{CONV}'",
        f"DELETE FROM agent_project_profiles WHERE member_id IN ('{AG_OK}','{AG_NO}','{AG_NULL}')",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','A4','a4org','free')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{P1}','{ORG}','P1',0)",
        # sender(human member) + 3 agents(members), runtime_type 차등
        "INSERT INTO members (id,org_id,type,name,is_active) VALUES "
        f"('{SENDER}','{ORG}','human','Sender',true),"
        f"('{AG_OK}','{ORG}','agent','HermesBot',true),"
        f"('{AG_NO}','{ORG}','agent','CCBot',true),"
        f"('{AG_NULL}','{ORG}','agent','BareBot',true)",
        f"UPDATE members SET runtime_type='hermes' WHERE id='{AG_OK}'",
        f"UPDATE members SET runtime_type='claude-code' WHERE id='{AG_NO}'",
        # AG_NULL: runtime_type 미설정(NULL)
        # 에이전트 뷰 출현(members ⋈ agent_project_profiles)
        "INSERT INTO agent_project_profiles (id,member_id,project_id,agent_role,fakechat_port) VALUES "
        f"(gen_random_uuid(),'{AG_OK}','{P1}','dev',9501),"
        f"(gen_random_uuid(),'{AG_NO}','{P1}','dev',9502),"
        f"(gen_random_uuid(),'{AG_NULL}','{P1}','dev',9503)",
        f"INSERT INTO conversations (id,project_id,org_id,type,created_by) VALUES ('{CONV}','{P1}','{ORG}','group','{SENDER}')",
        "INSERT INTO conversation_participants (conversation_id,member_id) VALUES "
        f"('{CONV}','{SENDER}'),('{CONV}','{AG_OK}'),('{CONV}','{AG_NO}'),('{CONV}','{AG_NULL}')",
    ]
    for s in stmts:
        await session.execute(text(s))
    await session.commit()


def _sender():
    return types.SimpleNamespace(id=SENDER, type="human", name="Sender")


def _msg(content: str):
    from app.models.conversation import ConversationMessage
    return ConversationMessage(id=uuid.uuid4(), conversation_id=CONV, sender_id=SENDER, content=content)


@pytest.mark.anyio
async def test_command_gate_blocks_unsupported_and_passes_supported():
    from sqlalchemy import select, text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.models.agent_deployment import AgentAuditLog
    from app.models.conversation import Conversation
    from app.routers.conversations import _command_capability_gate

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)

        # 커맨드 메시지 "/deploy" → hermes pass, claude-code/NULL 차단
        async with Session() as s:
            conv = (await s.execute(select(Conversation).where(Conversation.id == CONV))).scalar_one()
            blocked, hints = await _command_capability_gate(s, conv, _msg("/deploy now"), _sender(), ORG)
            await s.commit()

        assert blocked == {AG_NO, AG_NULL}, f"차단 집합 불일치: {blocked}"
        assert AG_OK not in blocked, "지원 런타임(hermes)이 차단됨(AC2 위반)"
        assert {h["agent_id"] for h in hints} == {str(AG_NO), str(AG_NULL)}
        assert all(h["reason"] == "unsupported_runtime" and h["command"] == "deploy" for h in hints)

        # AC3: audit log 2건 — command_blocked_unsupported_runtime
        async with Session() as s:
            rows = (await s.execute(select(AgentAuditLog).where(
                AgentAuditLog.org_id == ORG,
                AgentAuditLog.event_type == "command_blocked_unsupported_runtime",
            ))).scalars().all()
        assert len(rows) == 2, f"audit log 2건 아님: {len(rows)}"
        assert {r.agent_id for r in rows} == {AG_NO, AG_NULL}
        assert all(r.payload.get("command") == "deploy" for r in rows)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_non_command_message_is_not_gated():
    """회귀(AC4): 일반(비-command) 메시지는 게이트 무영향 — 차단 0·audit 0."""
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.models.agent_deployment import AgentAuditLog
    from app.models.conversation import Conversation
    from app.routers.conversations import _command_capability_gate

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            conv = (await s.execute(select(Conversation).where(Conversation.id == CONV))).scalar_one()
            blocked, hints = await _command_capability_gate(s, conv, _msg("배포 좀 해줘"), _sender(), ORG)
            await s.commit()
        assert blocked == set() and hints == [], f"비-command가 게이트됨: {blocked}"
        async with Session() as s:
            cnt = (await s.execute(select(AgentAuditLog).where(AgentAuditLog.org_id == ORG))).scalars().all()
        assert len(cnt) == 0, f"비-command인데 audit 생성: {len(cnt)}"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_escaped_command_is_literal_not_gated():
    """이스케이프(`//deploy`·선행공백)는 리터럴 → 게이트 무영향(S3 classifier 정합)."""
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.models.conversation import Conversation
    from app.routers.conversations import _command_capability_gate

    engine = create_async_engine(_ASYNC_URL)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            conv = (await s.execute(select(Conversation).where(Conversation.id == CONV))).scalar_one()
            for literal in ("//deploy", " /deploy"):
                blocked, hints = await _command_capability_gate(s, conv, _msg(literal), _sender(), ORG)
                assert blocked == set() and hints == [], f"이스케이프 {literal!r} 가 게이트됨"
            await s.rollback()
    finally:
        await engine.dispose()
