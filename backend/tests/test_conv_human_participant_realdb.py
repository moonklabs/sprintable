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
            assert await _conversation_has_human_participant(mixed, s, ORG) is True
            # ② agent-only(둘 다 뷰 agent) → False.
            agent_only = uuid.uuid4()
            await _conv_with(s, agent_only, [AGENT, AGENT2])
            assert await _conversation_has_human_participant(agent_only, s, ORG) is False
    finally:
        await engine.dispose()


ORG_B = uuid.UUID("e6000000-0000-0000-0000-000000000002")
AGENT_NO_PROFILE = uuid.UUID("e6000000-0000-0000-0000-0000000000a3")  # a member of the organization with NO project profile (so not in the team_members view)
AGENT_OTHER_ORG = uuid.UUID("e6000000-0000-0000-0000-0000000000a4")
PERSON = uuid.UUID("e6000000-0000-0000-0000-0000000000b1")
ADMIN = uuid.UUID("e6000000-0000-0000-0000-0000000000b2")


@pytest.mark.anyio
async def test_one_definition_of_who_is_an_agent_in_all_three_places():
    """story #4846 AC11 — «does this room have a person in it» has ONE definition (`participant_is_agent`: a `members` row of THIS organization with type agent) and the readable
    predicate, the single-room check and the bulk check all use it. The case that made it necessary: an agent whose only project was deleted has no profile row, so it is not in
    the `team_members` view any more — through the view a room of such agents read as a room with a person in it."""
    from sqlalchemy import select

    from app.models.conversation import Conversation
    from app.routers.conversations import _conversation_has_human_participant, _conversations_with_human_participant
    from app.services.conversation_auth import conversation_readable_predicate

    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as s:
            await _seed(s)
            for sql in [
                f"DELETE FROM members WHERE org_id='{ORG_B}'",
                f"DELETE FROM organizations WHERE id='{ORG_B}'",
                f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG_B}','E6b','e6orgb','free')",
                "INSERT INTO members (id,org_id,type,name,is_active) VALUES "
                f"('{AGENT_NO_PROFILE}','{ORG}','agent','NoProfile',true),('{PERSON}','{ORG}','human','Person',true),"
                f"('{ADMIN}','{ORG}','human','Admin',true),('{AGENT_OTHER_ORG}','{ORG_B}','agent','Other',true)",
            ]:
                await s.execute(text(sql))
            await s.commit()

            only_agents = uuid.uuid4()      # a profile-less agent and a profiled one: agents only
            await _conv_with(s, only_agents, [AGENT_NO_PROFILE, AGENT])
            with_person = uuid.uuid4()
            await _conv_with(s, with_person, [AGENT, PERSON])
            with_orphan = uuid.uuid4()      # an id that is no member at all counts as a person (conservative)
            await _conv_with(s, with_orphan, [AGENT, HUMAN_UNANCHORED])
            with_other_org_agent = uuid.uuid4()  # an agent of ANOTHER organization is not confirmed here, so it counts as a person
            await _conv_with(s, with_other_org_agent, [AGENT, AGENT_OTHER_ORG])
            rooms = {only_agents: False, with_person: True, with_orphan: True, with_other_org_agent: True}

            bulk = await _conversations_with_human_participant(list(rooms), s, ORG)
            for room, has_person in rooms.items():
                assert await _conversation_has_human_participant(room, s, ORG) is has_person, ("single", room)
                assert (room in bulk) is has_person, ("bulk", room)
                # the predicate: a non-participant admin reads the room only when it has no person in it
                readable = (await s.execute(select(conversation_readable_predicate(
                    Conversation.id, caller_member_id=ADMIN, org_id=ORG, admin_bypass_eligible=True,
                )).where(Conversation.id == room))).scalar_one()
                assert readable is (not has_person), ("predicate", room)
    finally:
        await engine.dispose()
