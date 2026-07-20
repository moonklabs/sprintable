"""story 455e528d(E-AUTH-REBUILD M2 Phase1-S2) 게이트: Firebase 세션 인증이 resource-actual
AuthContext를 만드는지 realdb로 실증 — doc §3.3 핵심 경고("never trust a stale Firebase
claim list")를 지키면서도 require_role/require_admin/get_org_scope/SSE 스트리밍이 실 DB
membership으로 정확히 동작하는지 매트릭스로 확認한다(발견 즉시 수정 — role 미주입 갭 포함).
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

import pytest
from fastapi.security import HTTPAuthorizationCredentials
from jose import jwt as jose_jwt

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

PROJECT_ID = "test-project"
KID = "test-kid-1"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    from app.services import firebase_verifier as fv
    fv._reset_key_cache_for_tests()
    yield
    fv._reset_key_cache_for_tests()
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


def _make_self_signed_cert() -> tuple[str, str]:
    with tempfile.TemporaryDirectory() as d:
        key_path = Path(d) / "key.pem"
        cert_path = Path(d) / "cert.pem"
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-keyout", str(key_path),
             "-out", str(cert_path), "-days", "1", "-nodes", "-subj", "/CN=test"],
            check=True, capture_output=True,
        )
        return key_path.read_text(), cert_path.read_text()


def _make_session_cookie(key_pem: str, sub: str) -> str:
    now = int(time.time())
    claims = {
        "sub": sub, "email": "user@test.com", "auth_time": now, "iat": now, "exp": now + 3600,
        "iss": f"https://session.firebase.google.com/{PROJECT_ID}", "aud": PROJECT_ID,
    }
    return jose_jwt.encode(claims, key_pem, algorithm="RS256", headers={"kid": KID})


async def _seed(session, *, org_role: str = "admin", user_active: bool = True):
    from app.core.security import hash_password
    from app.models.auth_identity import AuthIdentity
    from app.models.organization import Organization
    from app.models.project import OrgMember
    from app.models.user import User

    org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
    session.add(org)
    await session.commit()

    user_id = uuid.uuid4()
    session.add(User(
        id=user_id, email=f"authreb-s2-{user_id.hex[:8]}@test.com",
        hashed_password=hash_password("x"), is_active=user_active, email_verified=True,
        last_org_id=org.id,
    ))
    await session.commit()

    session.add(OrgMember(id=uuid.uuid4(), org_id=org.id, user_id=user_id, role=org_role))
    await session.commit()

    firebase_uid = f"fb-uid-{uuid.uuid4().hex[:8]}"
    issuer = f"https://session.firebase.google.com/{PROJECT_ID}"
    session.add(AuthIdentity(
        id=uuid.uuid4(), user_id=user_id, issuer=issuer, subject=firebase_uid,
        provider_id="password",
    ))
    await session.commit()

    return {"org_id": org.id, "user_id": user_id, "firebase_uid": firebase_uid}


@pytest.mark.anyio
async def test_admin_firebase_user_gets_real_role_not_default_member_realdb(monkeypatch):
    """⭐발견 즉시 수정 회귀 가드: Firebase 인증 admin이 require_admin/require_role을 통과해야
    한다(claims에 role을 안 채우면 전부 기본값 "member"로 평가돼 실제 admin도 거부당하던 갭)."""
    from app.core.config import settings
    from app.dependencies.auth import get_current_user, require_admin, require_role

    monkeypatch.setattr(settings, "firebase_auth_accept_session", True)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)

    key_pem, cert_pem = _make_self_signed_cert()
    from app.services import firebase_verifier as fv
    async def fake_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_public_keys", fake_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, org_role="admin")

        cookie = _make_session_cookie(key_pem, seeded["firebase_uid"])
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=cookie)

        async with Session() as s:
            auth = await get_current_user(credentials=credentials, x_agent_api_key=None, x_mcp_transport=None, db=s)

        assert auth.user_id == str(seeded["user_id"])
        assert auth.org_id == str(seeded["org_id"])
        assert auth.claims["app_metadata"]["role"] == "admin"

        # require_admin/require_role — Firebase claim이 아니라 이 resource-actual AuthContext로 평가.
        result = require_admin(auth)
        assert result.user_id == auth.user_id
        checked = require_role("admin", "owner")(auth)
        assert checked.user_id == auth.user_id
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_member_firebase_user_rejected_by_require_admin_realdb(monkeypatch):
    """까심: member role Firebase 사용자가 require_admin을 통과하면 IDOR급 권한 상승."""
    from app.core.config import settings
    from app.dependencies.auth import get_current_user, require_admin
    from fastapi import HTTPException

    monkeypatch.setattr(settings, "firebase_auth_accept_session", True)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)

    key_pem, cert_pem = _make_self_signed_cert()
    from app.services import firebase_verifier as fv
    async def fake_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_public_keys", fake_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, org_role="member")

        cookie = _make_session_cookie(key_pem, seeded["firebase_uid"])
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=cookie)

        async with Session() as s:
            auth = await get_current_user(credentials=credentials, x_agent_api_key=None, x_mcp_transport=None, db=s)

        assert auth.claims["app_metadata"]["role"] == "member"
        with pytest.raises(HTTPException) as exc_info:
            require_admin(auth)
        assert exc_info.value.status_code == 403
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_get_org_scope_reads_live_org_id_realdb(monkeypatch):
    from app.core.config import settings
    from app.dependencies.auth import get_current_user, get_org_scope

    monkeypatch.setattr(settings, "firebase_auth_accept_session", True)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)

    key_pem, cert_pem = _make_self_signed_cert()
    from app.services import firebase_verifier as fv
    async def fake_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_public_keys", fake_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, org_role="member")

        cookie = _make_session_cookie(key_pem, seeded["firebase_uid"])
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=cookie)

        async with Session() as s:
            auth = await get_current_user(credentials=credentials, x_agent_api_key=None, x_mcp_transport=None, db=s)

        org_id = get_org_scope(auth=auth, x_org_id=None)
        assert str(org_id) == str(seeded["org_id"])
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_disabled_user_rejected_despite_valid_firebase_token_realdb(monkeypatch):
    """doc §3.3: disabled/deleted Sprintable user는 유효한 Firebase 토큰이어도 거부."""
    from app.core.config import settings
    from app.dependencies.auth import get_current_user
    from fastapi import HTTPException

    monkeypatch.setattr(settings, "firebase_auth_accept_session", True)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)

    key_pem, cert_pem = _make_self_signed_cert()
    from app.services import firebase_verifier as fv
    async def fake_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_public_keys", fake_fetch)

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            seeded = await _seed(s, user_active=False)

        cookie = _make_session_cookie(key_pem, seeded["firebase_uid"])
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=cookie)

        async with Session() as s:
            with pytest.raises(HTTPException) as exc_info:
                await get_current_user(credentials=credentials, x_agent_api_key=None, x_mcp_transport=None, db=s)
            assert exc_info.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_unmapped_firebase_identity_rejected_realdb():
    """(issuer, sub)가 auth_identities에 없으면(=미프로비저닝 Firebase 사용자) 거부."""
    from app.core.config import settings
    from app.dependencies.auth import get_current_user
    from fastapi import HTTPException

    engine, Session = await _session_factory()
    try:
        from app.services import firebase_verifier as fv

        key_pem, cert_pem = _make_self_signed_cert()

        async def fake_fetch():
            return {KID: cert_pem}

        import pytest as _pytest  # local monkeypatch without fixture param name clash
        mp = _pytest.MonkeyPatch()
        mp.setattr(settings, "firebase_auth_accept_session", True)
        mp.setattr(settings, "firebase_project_id", PROJECT_ID)
        mp.setattr(fv, "_fetch_public_keys", fake_fetch)
        try:
            cookie = _make_session_cookie(key_pem, "never-provisioned-uid")
            credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=cookie)
            async with Session() as s:
                with pytest.raises(HTTPException) as exc_info:
                    await get_current_user(credentials=credentials, x_agent_api_key=None, x_mcp_transport=None, db=s)
                assert exc_info.value.status_code == 401
        finally:
            mp.undo()
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sse_streaming_variant_mirrors_dual_verifier_realdb(monkeypatch):
    """doc §4.3: get_current_user_streaming도 동일하게 Firebase 세션을 처리해야 한다.

    이 경로는 내부적으로 자체 단명 세션(async_session_factory())을 여는데(API key 경로와
    동형 — 스트림 yield 구간에 커넥션 미점유), 그 이름이 app.dependencies.auth 모듈에
    `from ... import async_session_factory`로 바인딩돼 있어 그 모듈 속성을 패치해야
    실제로 이 테스트의 realdb 세션팩토리를 쓴다(app.core.database 쪽을 패치해도 이미
    바인딩된 이름엔 영향 없음 — 기존 test_eventbus_s3.py는 dependency_overrides로
    이 함수 자체를 우회해 이 이슈를 안 겪었을 뿐, 직접 호출 시엔 실제로 필요)."""
    from app.core.config import settings
    import app.dependencies.auth as auth_module

    monkeypatch.setattr(settings, "firebase_auth_accept_session", True)
    monkeypatch.setattr(settings, "firebase_project_id", PROJECT_ID)

    key_pem, cert_pem = _make_self_signed_cert()
    from app.services import firebase_verifier as fv
    async def fake_fetch():
        return {KID: cert_pem}
    monkeypatch.setattr(fv, "_fetch_public_keys", fake_fetch)

    engine, Session = await _session_factory()
    monkeypatch.setattr(auth_module, "async_session_factory", Session)
    try:
        async with Session() as s:
            seeded = await _seed(s, org_role="admin")

        cookie = _make_session_cookie(key_pem, seeded["firebase_uid"])
        credentials = HTTPAuthorizationCredentials(scheme="Bearer", credentials=cookie)

        auth = await auth_module.get_current_user_streaming(credentials=credentials, x_agent_api_key=None)
        assert auth.user_id == str(seeded["user_id"])
        assert auth.claims["app_metadata"]["role"] == "admin"
    finally:
        await engine.dispose()
