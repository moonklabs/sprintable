"""story #4340 — 팀 멤버 수정 `{"role": null}`이 오류 없이 역할을 member로 강등하던 결함(실 PG · 라우터 표면).

예전(develop 42c09b091 · 실측): 조직 owner가 다른 휴먼(project_access.role = admin)에게 `PATCH /api/v2/team-members/{id}` `{"role": null}`
→ 200 · 응답 role = member · DB admin → member. 원인: exclude_unset이 null을 넘기고 → apply_anchor_update가 clamp_project_role(None)
(«enum 밖 값은 member» — 레거시 문자열 방어용)으로 정규화.
불변식: **역할은 명시 값일 때만 바뀐다** — null은 422 · 생략은 그대로 · 레거시 비-enum 문자열은 여전히 member로 정규화.
"""
from __future__ import annotations

import os
import uuid

import pytest

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace("postgresql://", "postgresql+asyncpg://")

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _engine():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(Session, target_role: str = "admin"):
    """조직 owner(호출자) + 같은 프로젝트의 다른 휴먼 구성원(project_access.role = target_role)."""
    from sqlalchemy import text
    ids = {k: uuid.uuid4() for k in ("org", "project", "admin_user", "target_user", "target_member", "access")}
    tag = uuid.uuid4().hex[:8]
    async with Session() as s:
        for sql, p in [
            ("INSERT INTO organizations (id,name,slug,plan) VALUES (:id,'O4340',:slug,'free')", {"id": ids["org"], "slug": f"o4340-{tag}"}),
            ("INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count)"
             " VALUES (:id,:e,'x','Admin',true,true,0,false,0)", {"id": ids["admin_user"], "e": f"a-{tag}@t4340.test"}),
            ("INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count)"
             " VALUES (:id,:e,'x','Target',true,true,0,false,0)", {"id": ids["target_user"], "e": f"t-{tag}@t4340.test"}),
            ("INSERT INTO org_members (id,org_id,user_id,role) VALUES (:id,:org,:u,'owner')", {"id": uuid.uuid4(), "org": ids["org"], "u": ids["admin_user"]}),
            ("INSERT INTO org_members (id,org_id,user_id,role) VALUES (:id,:org,:u,'member')", {"id": uuid.uuid4(), "org": ids["org"], "u": ids["target_user"]}),
            ("INSERT INTO projects (id,org_id,name,violation_level) VALUES (:id,:org,'P4340','none')", {"id": ids["project"], "org": ids["org"]}),
            ("INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES (:id,:org,:u,'human','Admin',true)", {"id": uuid.uuid4(), "org": ids["org"], "u": ids["admin_user"]}),
            ("INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES (:id,:org,:u,'human','Target',true)", {"id": ids["target_member"], "org": ids["org"], "u": ids["target_user"]}),
            ("INSERT INTO project_access (id,project_id,member_id,permission,role) VALUES (:id,:p,:m,'granted',:r)",
             {"id": ids["access"], "p": ids["project"], "m": ids["target_member"], "r": target_role}),
        ]:
            await s.execute(text(sql), p)
        await s.commit()
    return ids


async def _role(Session, access_id) -> str:
    from sqlalchemy import text
    async with Session() as s:
        return (await s.execute(text("SELECT role FROM project_access WHERE id=:id"), {"id": access_id})).scalar_one()


async def _patch(Session, ids, body):
    from httpx import ASGITransport, AsyncClient

    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app
    from tests.conftest import override_db_and_read

    async def _db():
        async with Session() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def _auth():
        return AuthContext(user_id=str(ids["admin_user"]), email="a@t4340.test",
                           claims={"app_metadata": {"org_id": str(ids["org"]), "project_id": str(ids["project"])}})

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    try:
        async with AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://t") as c:
            return await c.patch(f"/api/v2/team-members/{ids['target_member']}", json=body)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_role_null_is_422_and_role_unchanged():
    """⭐`{"role": null}` → 422 null_not_allowed · DB 역할 그대로(예전: 200 · admin → member)."""
    eng, Session = await _engine()
    try:
        ids = await _seed(Session, "admin")
        r = await _patch(Session, ids, {"role": None})
        assert r.status_code == 422 and "null_not_allowed" in r.text and "role" in r.text, r.text
        assert await _role(Session, ids["access"]) == "admin"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_role_changes_only_with_an_explicit_value():
    """생략(다른 필드만) → 그대로 · 명시 값 → 그 값 · 레거시 비-enum 문자열 → member(clamp는 그대로)."""
    eng, Session = await _engine()
    try:
        ids = await _seed(Session, "admin")
        r = await _patch(Session, ids, {"color": "#123456"})
        assert r.status_code == 200, r.text
        assert await _role(Session, ids["access"]) == "admin"
        r = await _patch(Session, ids, {"role": "member"})
        assert r.status_code == 200, r.text
        assert await _role(Session, ids["access"]) == "member"
        r = await _patch(Session, ids, {"role": "manager"})
        assert r.status_code == 200, r.text
        assert await _role(Session, ids["access"]) == "member"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_repository_refuses_none_role_instead_of_demoting():
    """AC3 — None은 clamp 길로 가지 않는다: 내부 호출이 role=None을 넘기면 강등 대신 멈춘다(fail-closed) · DB 그대로."""
    from app.repositories.team_member import TeamMemberRepository

    eng, Session = await _engine()
    try:
        ids = await _seed(Session, "admin")
        async with Session() as s:
            repo = TeamMemberRepository(s, ids["org"])
            member = await repo.get(ids["target_member"])
            assert member is not None
            with pytest.raises(ValueError, match="role cannot be None"):
                await repo.apply_anchor_update(member, {"role": None})
            await s.rollback()
        assert await _role(Session, ids["access"]) == "admin"
    finally:
        await eng.dispose()


def test_clamp_project_role_contract_unchanged_for_other_callers():
    """clamp_project_role 자체는 그대로 — 레거시 문자열 · None → member(초대 · 앵커 동기화 · 접근 판정이 기대는 계약). 강등을 막는 건 쓰는 자리."""
    from app.services.project_auth import clamp_project_role

    assert clamp_project_role("admin") == "admin"
    assert clamp_project_role("manager") == "member"
    assert clamp_project_role(None) == "member"
