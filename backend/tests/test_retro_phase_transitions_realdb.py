"""B1(9f27af8f): retro phase 3게이트+비차단+양방향 — realdb 전이 매트릭스 실증.

`set_phase`의 인접 양방향(collect↔vote↔action) + action→closed 편도 + closed terminal을
실 PG에서 라우터 함수(`advance_phase`)를 직접 호출해 실증한다. 특히 **양방향 데이터 보존**
(뒤로가기해도 기존 투표/그룹핑/액션이 안 사라짐)을 확인 — phase 컬럼만 바뀌고 나머지 테이블은
전혀 손대지 않는다는 설계 전제를 실측.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("cd000000-0000-0000-0000-000000000001")
USER = uuid.UUID("cd000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("cd000000-0000-0000-0000-0000000000b1")
PROJ = uuid.UUID("cd000000-0000-0000-0000-0000000000c1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


async def _seed_session(s, phase: str):
    from app.models.retro import RetroAction, RetroItem, RetroSession, RetroVote

    for sql in [
        f"DELETE FROM retro_actions WHERE session_id IN "
        f"(SELECT id FROM retro_sessions WHERE org_id='{ORG}')",
        f"DELETE FROM retro_votes WHERE item_id IN "
        f"(SELECT id FROM retro_items WHERE session_id IN "
        f"(SELECT id FROM retro_sessions WHERE org_id='{ORG}'))",
        f"DELETE FROM retro_items WHERE session_id IN (SELECT id FROM retro_sessions WHERE org_id='{ORG}')",
        f"DELETE FROM retro_sessions WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','CD','cd-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@cd.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ}','{OM}','granted')",
    ]:
        await s.execute(text(sql))

    sess = RetroSession(id=uuid.uuid4(), org_id=ORG, project_id=PROJ, title="r", phase=phase)
    s.add(sess)
    await s.flush()

    item = RetroItem(id=uuid.uuid4(), session_id=sess.id, category="good", text="i")
    s.add(item)
    await s.flush()
    vote = RetroVote(id=uuid.uuid4(), item_id=item.id, voter_id=OM)
    s.add(vote)
    action = RetroAction(id=uuid.uuid4(), session_id=sess.id, title="a")
    s.add(action)
    await s.flush()
    await s.commit()

    return {"session_id": sess.id, "item_id": item.id, "vote_id": vote.id, "action_id": action.id}


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytest.mark.parametrize(
    "start,target",
    [
        ("collect", "vote"),
        ("vote", "collect"),
        ("vote", "action"),
        ("action", "vote"),
        ("action", "closed"),
    ],
)
@pytest.mark.anyio
async def test_allowed_transitions(start, target):
    from app.repositories.retro import RetroSessionRepository
    from app.routers.retros import advance_phase
    from app.schemas.retro import PhaseTransition

    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed_session(s, start)

        async with Session() as s:
            out = await advance_phase(
                id=ids["session_id"], body=PhaseTransition(phase=target),
                db=s, auth=_auth(), repo=RetroSessionRepository(s, ORG),
            )
            assert out.phase == target
    finally:
        await eng.dispose()


@pytest.mark.parametrize(
    "start,target",
    [
        ("collect", "action"),
        ("collect", "closed"),
        ("vote", "closed"),
        ("closed", "action"),
        ("closed", "vote"),
        ("closed", "collect"),
    ],
)
@pytest.mark.anyio
async def test_rejected_non_adjacent_transitions(start, target):
    from app.repositories.retro import RetroSessionRepository
    from app.routers.retros import advance_phase
    from app.schemas.retro import PhaseTransition

    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed_session(s, start)

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await advance_phase(
                    id=ids["session_id"], body=PhaseTransition(phase=target),
                    db=s, auth=_auth(), repo=RetroSessionRepository(s, ORG),
                )
            assert ei.value.status_code == 400
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_backward_transition_preserves_all_data():
    """B1 핵심 — vote→collect 뒤로가기해도 item/vote/action 전부 그대로(phase 컬럼만 변경)."""
    from app.models.retro import RetroAction, RetroItem, RetroSession, RetroVote
    from app.repositories.retro import RetroSessionRepository
    from app.routers.retros import advance_phase
    from app.schemas.retro import PhaseTransition

    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed_session(s, "vote")

        async with Session() as s:
            out = await advance_phase(
                id=ids["session_id"], body=PhaseTransition(phase="collect"),
                db=s, auth=_auth(), repo=RetroSessionRepository(s, ORG),
            )
            await s.commit()
            assert out.phase == "collect"

        async with Session() as s:
            sess = (await s.execute(select(RetroSession).where(RetroSession.id == ids["session_id"]))).scalar_one()
            item = (await s.execute(select(RetroItem).where(RetroItem.id == ids["item_id"]))).scalar_one_or_none()
            vote = (await s.execute(select(RetroVote).where(RetroVote.id == ids["vote_id"]))).scalar_one_or_none()
            action = (await s.execute(select(RetroAction).where(RetroAction.id == ids["action_id"]))).scalar_one_or_none()
            assert sess.phase == "collect"
            assert item is not None
            assert vote is not None
            assert action is not None
    finally:
        await eng.dispose()
