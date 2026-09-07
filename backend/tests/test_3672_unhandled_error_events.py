"""story #3672(BE·BFF·FE·관측, 페드루 PO 確定 2026-09-07) — 미처리 500이 Cloud Run
로그에만 남아 사람(gcloud) 없이는 원인 재개가 안 되던 것(3663 실사고)을 닫는다.

이 파일의 관심사(BE 축만 — BFF/FE는 apps/web 쪽 자체 테스트 파일):
① unhandled_exception_handler가 error_id를 로그·응답 봉투에 싣는다
② 같은 id로 unhandled_error_events 1행이 best-effort로 남는다(저장 실패해도 500
   응답 자체는 그대로) ③ 비밀값(쿼리스트링 등) 미저장 ④ platform-admin GET 조회
⑤ 30일 보존 정리 스윕."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi import Depends, Request

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    engine = create_async_engine(_async_url())
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _client_for(app):
    from httpx import AsyncClient, ASGITransport
    # raise_app_exceptions=False — test_2003 선례와 동형: 강제 unhandled 500이 ASGI
    # ServerErrorMiddleware의 재-raise로 pytest 실패를 오인하지 않게 억제.
    return AsyncClient(transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://test")


async def _seed_org_and_user(session):
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org3672", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()
    user = User(id=uuid.uuid4(), email=f"human-{uuid.uuid4().hex[:8]}@test.dev", hashed_password="x")
    session.add(user)
    await session.commit()
    om = OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user.id, role="member")
    session.add(om)
    await session.commit()
    return org.id, user.id


# ── AC1/AC2 — 핸들러가 error_id를 로그+응답+DB에 같은 값으로 싣는다 ────────────


@pytest.mark.anyio
async def test_unhandled_exception_returns_error_id_and_persists_row_with_auth_context():
    from app.main import app
    from app.dependencies.database import get_db
    from app.dependencies.auth import AuthContext, get_current_user
    from app.models.unhandled_error_event import UnhandledErrorEvent
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org_id, user_id = await _seed_org_and_user(s)

        async def _db():
            async with Session() as s:
                yield s

        # 실 get_current_user와 동형으로 request.state.au_org_id/au_user_id를 직접
        # 채운다(main.py::unhandled_exception_handler 소비처③) — 「인증 성공 뒤 죽음」
        # 시나리오를 재현. Depends(Request)로 FastAPI가 그대로 주입해 준다.

        async def _auth_with_state(request: Request) -> AuthContext:
            request.state.au_org_id = str(org_id)
            request.state.au_user_id = str(user_id)
            return AuthContext(user_id=str(user_id), email="caller@test", claims={}, org_id=str(org_id))

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_current_user] = _auth_with_state

        # 테스트 전용 라우트 — 인증 dependency가 먼저 resolve된 뒤(request.state 채워짐)
        # 본문에서 강제로 미처리 예외를 던진다(진짜 버그 시뮬레이션, #2003 선례와 동형).
        async def _boom(auth: AuthContext = Depends(get_current_user)):
            raise RuntimeError("s3672 forced unhandled failure")
        app.add_api_route("/__test_3672_boom", _boom, methods=["GET"])
        try:
            # record_unhandled_error_event가 내부에서 late-import하는 app.core.database.
            # async_session_factory는 앱의 실 설정(DATABASE_URL)을 가리켜 이 테스트의
            # 격리 PG(_REAL_DB_URL)와 다르다 — 이 파일의 Session(위 _session_factory 산출)
            # 으로 바꿔치기해야 그 자리도 같은 테스트 DB에 쓴다(test_ob4b_funnel_seams.py
            # 선례와 동형 patch 지점).
            with patch("app.core.database.async_session_factory", new=Session):
                client = _client_for(app)
                try:
                    resp = await client.get("/__test_3672_boom")
                    assert resp.status_code == 500, resp.text
                    body = resp.json()
                    error_id = body["error"]["error_id"]
                    uuid.UUID(error_id)  # 유효한 uuid4 형식
                    assert body["error"]["code"] == "INTERNAL_ERROR"
                finally:
                    await client.aclose()

            async with Session() as s:
                row = (await s.execute(
                    select(UnhandledErrorEvent).where(UnhandledErrorEvent.id == uuid.UUID(error_id))
                )).scalar_one_or_none()
            assert row is not None, "unhandled_error_events 행이 안 남음"
            assert row.method == "GET"
            assert row.path == "/__test_3672_boom"
            assert row.exception_class == "RuntimeError"
            assert row.message == "s3672 forced unhandled failure"
            assert row.org_id == org_id
            assert row.user_id == user_id
        finally:
            app.router.routes[:] = [r for r in app.router.routes if getattr(r, "path", None) != "/__test_3672_boom"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_unhandled_exception_before_auth_persists_null_org_and_user():
    """인증 자체가 죽으면(request.state가 안 채워진 채) org_id/user_id는 null이
    정직한 값 — 지어내지 않는다(AC2 "알 때만")."""
    from app.main import app
    from app.dependencies.database import get_db
    from app.dependencies.auth import get_current_user
    from app.models.unhandled_error_event import UnhandledErrorEvent
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async def _db():
            async with Session() as s:
                yield s

        async def _boom_auth():
            raise RuntimeError("s3672 forced auth failure")

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_current_user] = _boom_auth

        from app.dependencies.auth import AuthContext

        async def _route(auth: AuthContext = Depends(get_current_user)):
            return {"ok": True}

        app.add_api_route("/__test_3672_boom_auth", _route, methods=["GET"])
        try:
            with patch("app.core.database.async_session_factory", new=Session):
                client = _client_for(app)
                try:
                    resp = await client.get("/__test_3672_boom_auth")
                    assert resp.status_code == 500, resp.text
                    error_id = resp.json()["error"]["error_id"]
                finally:
                    await client.aclose()

            async with Session() as s:
                row = (await s.execute(
                    select(UnhandledErrorEvent).where(UnhandledErrorEvent.id == uuid.UUID(error_id))
                )).scalar_one_or_none()
            assert row is not None
            assert row.org_id is None
            assert row.user_id is None
            assert row.exception_class == "RuntimeError"
        finally:
            app.router.routes[:] = [r for r in app.router.routes if getattr(r, "path", None) != "/__test_3672_boom_auth"]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_persist_failure_does_not_block_the_500_response():
    """AC2 — 저장이 실패해도(예: DB 자체가 안 닿음) 원래의 500 응답은 그대로 나간다
    (best-effort, fail-silent). 뮤테이션 대상 — main.py의 try/except를 없애면 이
    테스트가 500 대신 unhandled RuntimeError로 죽어 RED가 된다."""
    from app.main import app
    from app.dependencies.database import get_db
    from app.dependencies.auth import AuthContext, get_current_user
    import app.services.unhandled_error_events as uee_mod

    engine, Session = await _session_factory()
    try:
        async def _db():
            async with Session() as s:
                yield s

        async def _auth():
            return AuthContext(user_id=str(uuid.uuid4()), email="caller@test", claims={})

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_current_user] = _auth


        async def _boom(auth: AuthContext = Depends(get_current_user)):
            raise RuntimeError("s3672 forced unhandled failure")

        app.add_api_route("/__test_3672_boom_persist_fail", _boom, methods=["GET"])
        try:
            with patch.object(
                uee_mod, "record_unhandled_error_event",
                side_effect=RuntimeError("db unreachable — simulated persist failure"),
            ):
                client = _client_for(app)
                try:
                    resp = await client.get("/__test_3672_boom_persist_fail")
                    assert resp.status_code == 500, resp.text
                    body = resp.json()
                    assert body["error"]["code"] == "INTERNAL_ERROR"
                    uuid.UUID(body["error"]["error_id"])  # 저장 실패해도 error_id는 그대로 실린다
                finally:
                    await client.aclose()
        finally:
            app.router.routes[:] = [
                r for r in app.router.routes if getattr(r, "path", None) != "/__test_3672_boom_persist_fail"
            ]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_persisted_path_excludes_query_string_even_if_request_had_one():
    """AC2 "비밀값(쿼리스트링) 미저장" — request.url.path 자체가 쿼리 없는 값이라
    보장되지만, oauth-channel authorize/callback 같은 자리는 쿼리에 code/state
    (사실상 비밀)를 싣는다 — 그 요청이 500나도 path 컬럼엔 안 새는지 직접 확認."""
    from app.main import app
    from app.dependencies.database import get_db
    from app.dependencies.auth import AuthContext, get_current_user
    from app.models.unhandled_error_event import UnhandledErrorEvent
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        async def _db():
            async with Session() as s:
                yield s

        async def _auth():
            return AuthContext(user_id=str(uuid.uuid4()), email="caller@test", claims={})

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[get_current_user] = _auth


        async def _boom(auth: AuthContext = Depends(get_current_user)):
            raise RuntimeError("s3672 forced unhandled failure")

        app.add_api_route("/__test_3672_boom_query", _boom, methods=["GET"])
        try:
            with patch("app.core.database.async_session_factory", new=Session):
                client = _client_for(app)
                try:
                    resp = await client.get("/__test_3672_boom_query?code=SECRET-OAUTH-CODE&state=SECRET-STATE-JWT")
                    error_id = resp.json()["error"]["error_id"]
                finally:
                    await client.aclose()

            async with Session() as s:
                row = (await s.execute(
                    select(UnhandledErrorEvent).where(UnhandledErrorEvent.id == uuid.UUID(error_id))
                )).scalar_one_or_none()
            assert row.path == "/__test_3672_boom_query"
            assert "SECRET" not in row.path
            assert row.message is None or "SECRET" not in row.message
        finally:
            app.router.routes[:] = [
                r for r in app.router.routes if getattr(r, "path", None) != "/__test_3672_boom_query"
            ]
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── AC3 — platform-admin GET 조회 ──────────────────────────────────────────


@pytest.mark.anyio
async def test_admin_get_unhandled_error_returns_stored_row():
    from app.main import app
    from app.dependencies.database import get_db
    from app.dependencies.admin_auth import AdminOperator, require_admin_operator
    from app.models.unhandled_error_event import UnhandledErrorEvent

    engine, Session = await _session_factory()
    try:
        error_id = uuid.uuid4()
        async with Session() as s:
            s.add(UnhandledErrorEvent(
                id=error_id, method="POST", path="/api/v2/organizations/x/channel-connections/y/callback",
                exception_class="KeyError", message="'foo'", org_id=None, user_id=None, request_id=None,
            ))
            await s.commit()

        async def _db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[require_admin_operator] = lambda: AdminOperator(email="op@moonklabs.com", subject="sub-1")

        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/admin/unhandled-errors/{error_id}")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["id"] == str(error_id)
            assert body["exception_class"] == "KeyError"
            assert body["method"] == "POST"
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.anyio
async def test_admin_get_unhandled_error_404_for_unknown_id():
    from app.main import app
    from app.dependencies.database import get_db
    from app.dependencies.admin_auth import AdminOperator, require_admin_operator

    engine, Session = await _session_factory()
    try:
        async def _db():
            async with Session() as s:
                yield s

        app.dependency_overrides[get_db] = _db
        app.dependency_overrides[require_admin_operator] = lambda: AdminOperator(email="op@moonklabs.com", subject="sub-1")

        client = _client_for(app)
        try:
            resp = await client.get(f"/api/v2/admin/unhandled-errors/{uuid.uuid4()}")
            assert resp.status_code == 404
        finally:
            await client.aclose()
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


# ── AC2 — 30일 보존 정리 스윕 ────────────────────────────────────────────────


@pytest.mark.anyio
async def test_sweep_deletes_only_rows_older_than_30_days():
    from app.models.unhandled_error_event import UnhandledErrorEvent
    from app.services.unhandled_error_events import sweep_old_unhandled_error_events
    from sqlalchemy import select

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        old_id, recent_id = uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            s.add(UnhandledErrorEvent(
                id=old_id, method="GET", path="/old", exception_class="RuntimeError", message=None,
            ))
            s.add(UnhandledErrorEvent(
                id=recent_id, method="GET", path="/recent", exception_class="RuntimeError", message=None,
            ))
            await s.commit()
            # occurred_at은 server_default이라 커밋 뒤 직접 UPDATE로 시점을 되돌린다
            # (다른 story의 30일 스윕 테스트들과 동형 관례 — created_at 직접 조작).
            from sqlalchemy import update
            await s.execute(
                update(UnhandledErrorEvent).where(UnhandledErrorEvent.id == old_id)
                .values(occurred_at=now - timedelta(days=31))
            )
            await s.commit()

        async with Session() as s:
            swept = await sweep_old_unhandled_error_events(s, now=now)
            assert swept == 1

        async with Session() as s:
            remaining_ids = set((await s.execute(select(UnhandledErrorEvent.id))).scalars().all())
        assert old_id not in remaining_ids
        assert recent_id in remaining_ids
    finally:
        await engine.dispose()
