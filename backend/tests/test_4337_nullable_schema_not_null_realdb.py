"""story #4337 — 요청 스키마는 null을 받는데 DB 칸은 NOT NULL인 짝(실 PG · 라우터 표면).

AC1 실측(develop 229721164)은 PR 본문 표. 이 파일은 고친 뒤의 계약을 고정한다: NOT NULL 칸에 명시 null → 422(저장까지 가서
무결성 오류 500이 되지 않게) · 행은 그대로. 미팅 경로 테스트는 PR 4690(meeting_type 매핑) 병합 뒤 이 파일에 더한다.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

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


async def _seed(session):
    from sqlalchemy import text
    org, project, user, om, member = (uuid.uuid4() for _ in range(5))
    tag = uuid.uuid4().hex[:8]
    for sql, params in [
        ("INSERT INTO organizations (id,name,slug,plan) VALUES (:id,'O4337',:slug,'free')", {"id": org, "slug": f"o4337-{tag}"}),
        ("INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,login_fail_count,totp_enabled,totp_fail_count)"
         " VALUES (:id,:email,'x','U',true,true,0,false,0)", {"id": user, "email": f"u-{tag}@t4337.test"}),
        # owner — project_access 없이도 전 프로젝트 접근(opt-out grant 모델).
        ("INSERT INTO org_members (id,org_id,user_id,role) VALUES (:id,:org,:user,'owner')", {"id": om, "org": org, "user": user}),
        ("INSERT INTO projects (id,org_id,name,violation_level) VALUES (:id,:org,'P4337','none')", {"id": project, "org": org}),
        ("INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES (:id,:org,:user,'human','U',true)", {"id": member, "org": org, "user": user}),
    ]:
        await session.execute(text(sql), params)
    await session.commit()
    return {"org": org, "project": project, "user": user, "member": member}


def _client(app):
    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test")


async def _app_for(seeded, Session):
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
        claims = {"app_metadata": {"org_id": str(seeded["org"]), "project_id": str(seeded["project"])}}
        return AuthContext(user_id=str(seeded["user"]), email="u@t4337.test", claims=claims)

    override_db_and_read(app, _db)
    app.dependency_overrides[get_current_user] = _auth
    return app


async def _engine():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _make_hypothesis(Session, seeded):
    from sqlalchemy import text
    hid = uuid.uuid4()
    async with Session() as s:
        await s.execute(text(
            "INSERT INTO hypotheses (id,org_id,project_id,owner_member_id,statement,metric_definition,measure_after,status)"
            " VALUES (:id,:org,:project,:owner,'가설',CAST(:md AS jsonb),:ma,'proposed')"
        ), {"id": hid, "org": seeded["org"], "project": seeded["project"], "owner": seeded["member"],
            "md": '{"metric":"x","source":"manual","target":1,"direction":"up"}',
            "ma": datetime.now(timezone.utc) + timedelta(days=14)})
        await s.commit()
    return hid


async def _run(check):
    eng, Session = await _engine()
    try:
        async with Session() as s:
            seeded = await _seed(s)
        app = await _app_for(seeded, Session)
        async with _client(app) as c:
            await check(c, seeded, Session)
    finally:
        from app.main import app as _app
        _app.dependency_overrides.clear()
        await eng.dispose()


def _null_rejected(resp, field: str) -> bool:
    return resp.status_code == 422 and field in resp.text and "null_not_allowed" in resp.text


@pytest.mark.anyio
async def test_hypothesis_update_measure_after_null_is_422():
    """AC1 (c) — 가설 수정 measure_after: null은 develop에서 NotNullViolation 500 → 422 · 행 그대로."""
    async def check(c, seeded, Session):
        from sqlalchemy import text
        hid = await _make_hypothesis(Session, seeded)
        r = await c.patch(f"/api/v2/hypotheses/{hid}", json={"measure_after": None})
        assert _null_rejected(r, "measure_after"), r.text
        async with Session() as s:
            assert (await s.execute(text("SELECT measure_after FROM hypotheses WHERE id=:id"), {"id": hid})).scalar_one() is not None
    await _run(check)
