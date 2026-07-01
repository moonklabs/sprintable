"""#1801 까심 QA HIGH: 회고(retros) same-org cross-project IDOR — realdb repro + lock.

갭: `retros.py`의 `_get_session_repo`가 org-level(`get_verified_org_id`)만 검증해 同org
**해당 project 접근권 없는** 멤버가 타 project retro session/item/action을 read/mutate 가능했음
(update_action이 원 적출 지점 — B3 완료토글 사용처). doc-gate #1796과 동일 패턴 fix:
대상 session을 org-scope로 로드 후 caller의 `has_project_access(session.project_id)` 강제.

본 테스트는 **fix 후 거동**(cross-project=403·same-project=통과·2차 item/action-session 불일치=404)을
assert. realdb 필수(has_project_access SSOT=team_member∪grant∪owner/admin·grant row 실측)."""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("ca000000-0000-0000-0000-000000000001")
USER = uuid.UUID("ca000000-0000-0000-0000-0000000000a1")
OM = uuid.UUID("ca000000-0000-0000-0000-0000000000b1")
PROJ_A = uuid.UUID("ca000000-0000-0000-0000-0000000000c1")  # USER grant(접근 O)
PROJ_B = uuid.UUID("ca000000-0000-0000-0000-0000000000c2")  # USER 접근 X(IDOR 축)
AGENT = uuid.UUID("ca000000-0000-0000-0000-0000000000e1")  # agent member·grant 0


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


def _agent_auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(AGENT), email=None, claims={}, org_id=str(ORG))


async def _seed(s):
    """ORG·USER(member·PROJ_A grant만)·PROJ_A/PROJ_B + 각 project에 retro session
    (session_a 는 PROJ_A에 2개 — 2차 IDOR 테스트용: session_a1과 session_a2가 서로 다름)."""
    for sql in [
        f"DELETE FROM retro_actions WHERE session_id IN "
        f"(SELECT id FROM retro_sessions WHERE org_id='{ORG}')",
        f"DELETE FROM retro_items WHERE session_id IN "
        f"(SELECT id FROM retro_sessions WHERE org_id='{ORG}')",
        f"DELETE FROM retro_sessions WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id IN ('{PROJ_A}','{PROJ_B}')",
        f"DELETE FROM org_members WHERE org_id='{ORG}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','CA','ca-org','free')",
        "INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES ('{USER}','u@ca.test','x','U',true,true,0,false,0)",
        f"INSERT INTO org_members (id,org_id,user_id,role) VALUES ('{OM}','{ORG}','{USER}','member')",
        f"INSERT INTO members (id,org_id,type,name,is_active) VALUES ('{AGENT}','{ORG}','agent','Ag',true)",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_A}','{ORG}','A')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ_B}','{ORG}','B')",
        f"INSERT INTO project_access (id,project_id,org_member_id,permission) "
        f"VALUES (gen_random_uuid(),'{PROJ_A}','{OM}','granted')",
    ]:
        await s.execute(text(sql))

    from app.models.retro import RetroAction, RetroItem, RetroSession

    ids: dict = {}
    for key, pid in [("a1", PROJ_A), ("a2", PROJ_A), ("b", PROJ_B)]:
        sess = RetroSession(id=uuid.uuid4(), org_id=ORG, project_id=pid, title=f"retro-{key}", phase="collect")
        s.add(sess)
        ids[f"session_{key}"] = sess.id
    await s.flush()

    item_a2 = RetroItem(id=uuid.uuid4(), session_id=ids["session_a2"], category="good", text="x")
    action_a2 = RetroAction(id=uuid.uuid4(), session_id=ids["session_a2"], title="t")
    s.add_all([item_a2, action_a2])
    await s.flush()
    ids["item_a2"] = item_a2.id
    ids["action_a2"] = action_a2.id

    await s.commit()
    return ids


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


# ───────────────────────── update_action (#1801 원 적출 지점) ─────────────────────────

@pytest.mark.anyio
async def test_update_action_cross_project_forbidden_same_project_ok():
    from app.repositories.retro import RetroActionRepository, RetroSessionRepository
    from app.routers.retros import update_action
    from app.schemas.retro import UpdateAction

    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed(s)
            action_repo = RetroActionRepository(s)
            action_b = await action_repo.create(session_id=ids["session_b"], title="hack target")
            await s.commit()

        # cross-project(PROJ_B·USER 무접근) → 403
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await update_action(
                    id=ids["session_b"], action_id=action_b.id, body=UpdateAction(status="done"),
                    db=s, auth=_auth(), repo=RetroSessionRepository(s, ORG),
                )
            assert ei.value.status_code == 403

        # same-project(PROJ_A·grant) → 통과
        async with Session() as s:
            out = await update_action(
                id=ids["session_a2"], action_id=ids["action_a2"], body=UpdateAction(status="done"),
                db=s, auth=_auth(), repo=RetroSessionRepository(s, ORG),
            )
            assert out.status == "done"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_update_action_wrong_session_forbidden():
    """action이 실존 + parent project 접근권 있어도, 선언한 session_id 소속이 아니면 404(2차 IDOR)."""
    from app.repositories.retro import RetroSessionRepository
    from app.routers.retros import update_action
    from app.schemas.retro import UpdateAction

    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed(s)

        # action_a2 는 session_a2 소속인데 session_a1(같은 PROJ_A·접근 O)로 호출 — 404 여야.
        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await update_action(
                    id=ids["session_a1"], action_id=ids["action_a2"], body=UpdateAction(status="done"),
                    db=s, auth=_auth(), repo=RetroSessionRepository(s, ORG),
                )
            assert ei.value.status_code == 404
    finally:
        await eng.dispose()


# ───────────────────────── get_session (read) ─────────────────────────

@pytest.mark.anyio
async def test_get_session_cross_project_forbidden_same_project_ok():
    from app.repositories.retro import RetroSessionRepository
    from app.routers.retros import get_session

    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed(s)

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await get_session(
                    id=ids["session_b"], db=s, auth=_auth(), repo=RetroSessionRepository(s, ORG)
                )
            assert ei.value.status_code == 403

        async with Session() as s:
            out = await get_session(
                id=ids["session_a1"], db=s, auth=_auth(), repo=RetroSessionRepository(s, ORG)
            )
            assert out.id == ids["session_a1"]
    finally:
        await eng.dispose()


# ───────────────────────── create_session(body.project_id 신뢰 mutation) ─────────────────────────

@pytest.mark.anyio
async def test_create_session_untrusted_project_id_forbidden():
    from app.routers.retros import create_session
    from app.schemas.retro import CreateSession

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await create_session(
                    body=CreateSession(project_id=PROJ_B, org_id=ORG, title="무단 생성"),
                    db=s, auth=_auth(), org_id=ORG,
                )
            assert ei.value.status_code == 403

        async with Session() as s:
            out = await create_session(
                body=CreateSession(project_id=PROJ_A, org_id=ORG, title="정상 생성"),
                db=s, auth=_auth(), org_id=ORG,
            )
            assert out.project_id == PROJ_A
    finally:
        await eng.dispose()


# ───────────────────────── agent(grant 0 → 차단) ─────────────────────────

@pytest.mark.anyio
async def test_agent_without_grant_cross_project_forbidden():
    """agent 키(grant 0)도 cross-project read/mutate 차단 — has_project_access agent 분기가
    grant 없으면 False → 403(fail-open 아님)."""
    from app.repositories.retro import RetroSessionRepository
    from app.routers.retros import get_session

    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed(s)

        async with Session() as s:
            with pytest.raises(HTTPException) as ei:
                await get_session(
                    id=ids["session_a1"], db=s, auth=_agent_auth(), repo=RetroSessionRepository(s, ORG)
                )
            assert ei.value.status_code == 403
    finally:
        await eng.dispose()
