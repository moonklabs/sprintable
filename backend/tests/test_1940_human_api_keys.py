"""story #1940 — 휴먼 개인 API 키 셀프서브 발급(MCP 설정). PO A안 판정(2026-08-16): 완전히
별도 테이블(human_api_keys)·접두사(hu_live_)·인증 해소 경로 — agent_api_keys/ApiKey와
0줄 접촉. 핵심 불변식: 이 경로로 인증된 요청은 `resolve_member()`류의
`is_api_key = bool(app_metadata.get("api_key_id"))` 휴리스틱에서 반드시 False로 떨어져야
한다(그래야 JWT 휴먼과 동일하게 취급돼 agent로 오판정되지 않는다, app/dependencies/
auth.py:131 "api_key 경로=에이전트" 불변식 + #1561 교훈).

검증 축:
- 레포지토리: create/list/revoke.
- 인증 해소: 정상 키 → AuthContext(user_id=users.id, api_key_id claim 없음, actor_type=human).
  폐기·만료·미존재 키 → 401. member 조회 시점 재검증(발급 뒤 human이 아니게 되면 401).
- ⭐AC2 핵심(PO 추가): x-agent-api-key 헤더로 hu_live_ 토큰을 보내면 인증되지 않는다(agent
  전용 표면 서버 거부) — 실제 get_current_user 호출로 재현.
- 셀프서브 라우터: 본인 키만 조회/폐기 가능(다른 사람 키는 404 — IDOR 표면 자체가 path에
  임의 id를 안 받아 구조적으로 없음, 그래도 방어 확인).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = pytest.mark.destructive_schema


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _realdb_session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed_org(session, *, slug="acme1940"):
    from app.models.organization import Organization
    org = Organization(id=uuid.uuid4(), name=f"Org-{slug}", slug=slug)
    session.add(org)
    await session.commit()
    return org.id


async def _seed_user(session, *, email="human1940@example.com"):
    from app.models.user import User
    user = User(id=uuid.uuid4(), email=email, hashed_password="x", is_active=True, email_verified=True)
    session.add(user)
    await session.commit()
    return user.id


async def _seed_human_member(session, org_id, user_id, *, name="Human"):
    from app.models.member import Member
    m = Member(id=uuid.uuid4(), org_id=org_id, type="human", user_id=user_id, name=name)
    session.add(m)
    await session.commit()
    return m.id


async def _seed_agent_member(session, org_id, *, name="Agent"):
    from app.models.member import Member
    m = Member(id=uuid.uuid4(), org_id=org_id, type="agent", name=name)
    session.add(m)
    await session.commit()
    return m.id


# ─── 레포지토리 축 ────────────────────────────────────────────────────────────


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_repo_create_list_revoke_roundtrip():
    from app.repositories.human_api_key import HumanApiKeyRepository

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_user(s)
            member_id = await _seed_human_member(s, org_id, user_id)

            repo = HumanApiKeyRepository(s)
            key, plaintext = await repo.create(member_id=member_id, name="laptop", expires_at=None)
            await s.commit()
            assert plaintext.startswith("hu_live_")
            assert key.key_prefix.startswith("hu_live_")
            assert plaintext != key.key_prefix  # prefix는 접두 일부일 뿐, 평문 전체가 아님

            listed = await repo.list_by_member(member_id)
            assert [k.id for k in listed] == [key.id]

            revoked = await repo.revoke(key.id)
            await s.commit()
            assert revoked.revoked_at is not None
    finally:
        await engine.dispose()


# ─── story #2839(#2838 사람 키 판) — 침묵 90일 각인 회귀가드 ──────────────────────


def test_create_request_schema_requires_expires_at_field():
    """expires_at 필드 자체가 요청에 없으면 422급(pydantic ValidationError) — null은 여전히
    유효한 값(명시적 무만료), «필드 생략»만 거절한다."""
    import pydantic
    from app.schemas.human_api_key import CreateHumanApiKeyRequest

    with pytest.raises(pydantic.ValidationError):
        CreateHumanApiKeyRequest(name="laptop")  # expires_at 누락.

    # null은 여전히 valid(명시적 무만료) — 위와 대조.
    req = CreateHumanApiKeyRequest(name="laptop", expires_at=None)
    assert req.expires_at is None


@pytest.mark.anyio
async def test_repo_create_requires_expires_at_kwarg():
    """repo 층도 동형 — expires_at 없이 호출하면 TypeError(호출부가 반드시 의도를 명시)."""
    from app.repositories.human_api_key import HumanApiKeyRepository

    repo = HumanApiKeyRepository(session=None)  # 호출 자체가 TypeError로 죽어야 하니 세션 불요.
    with pytest.raises(TypeError):
        await repo.create(member_id=uuid.uuid4())  # type: ignore[call-arg]


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_repo_create_no_more_silent_90_day_default_realdb():
    """회귀가드 핵심 — expires_at=None을 명시하면 실제로 NULL(무만료)로 저장된다. 예전엔
    repo 층이 몰래 now+90일을 각인했다(이 스토리의 근본 결함)."""
    from app.repositories.human_api_key import HumanApiKeyRepository

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_user(s)
            member_id = await _seed_human_member(s, org_id, user_id)

            repo = HumanApiKeyRepository(s)
            key, _plaintext = await repo.create(member_id=member_id, expires_at=None)
            await s.commit()
            assert key.expires_at is None

        # DB 재조회로 persist 자체를 확認(세션 캐시값이 아닌 실 저장값).
        async with Session() as s2:
            from sqlalchemy import select

            from app.models.human_api_key import HumanApiKey

            reread = (await s2.execute(
                select(HumanApiKey.expires_at).where(HumanApiKey.id == key.id)
            )).scalar_one()
            assert reread is None
    finally:
        await engine.dispose()


# ─── 인증 해소 축 ─────────────────────────────────────────────────────────────


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_resolve_human_api_key_returns_jwt_shaped_context_no_api_key_id_claim():
    """⭐핵심 불변식 — api_key_id claim이 없어야 resolve_member()류가 JWT 휴먼으로 취급한다."""
    from app.dependencies.auth import _resolve_human_api_key
    from app.repositories.human_api_key import HumanApiKeyRepository

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_user(s)
            member_id = await _seed_human_member(s, org_id, user_id)
            repo = HumanApiKeyRepository(s)
            _key, plaintext = await repo.create(member_id=member_id, expires_at=None)
            await s.commit()

        async with Session() as s2:
            ctx = await _resolve_human_api_key(plaintext, s2)

        assert ctx.user_id == str(user_id)
        assert ctx.org_id == str(org_id)
        app_meta = ctx.claims["app_metadata"]
        assert "api_key_id" not in app_meta  # is_api_key 휴리스틱을 절대 안 건드림
        assert app_meta["human_api_key_id"]
        assert app_meta["actor_type"] == "human"
        assert bool(app_meta.get("api_key_id")) is False  # resolve_member()가 실제로 읽는 그 조건식
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_resolve_human_api_key_rejects_revoked():
    from fastapi import HTTPException
    from app.dependencies.auth import _resolve_human_api_key
    from app.repositories.human_api_key import HumanApiKeyRepository

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_user(s)
            member_id = await _seed_human_member(s, org_id, user_id)
            repo = HumanApiKeyRepository(s)
            key, plaintext = await repo.create(member_id=member_id, expires_at=None)
            await repo.revoke(key.id)
            await s.commit()

        async with Session() as s2:
            with pytest.raises(HTTPException) as ei:
                await _resolve_human_api_key(plaintext, s2)
            assert ei.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_resolve_human_api_key_rejects_expired():
    from fastapi import HTTPException
    from app.dependencies.auth import _resolve_human_api_key
    from app.repositories.human_api_key import HumanApiKeyRepository

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_user(s)
            member_id = await _seed_human_member(s, org_id, user_id)
            repo = HumanApiKeyRepository(s)
            _key, plaintext = await repo.create(
                member_id=member_id, expires_at=datetime.now(timezone.utc) - timedelta(days=1),
            )
            await s.commit()

        async with Session() as s2:
            with pytest.raises(HTTPException) as ei:
                await _resolve_human_api_key(plaintext, s2)
            assert ei.value.status_code == 401
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_resolve_human_api_key_reverifies_member_still_human_fail_closed():
    """발급 시점엔 human이었어도 해소 시점에 다시 확認 — 여기선 agent로 「전환된」 member를
    직접 만들어(role/type 전환 시나리오 대리 재현) fail-closed 확認."""
    from fastapi import HTTPException
    from app.dependencies.auth import _resolve_human_api_key
    from app.repositories.human_api_key import HumanApiKeyRepository
    from app.models.member import Member

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_user(s)
            member_id = await _seed_human_member(s, org_id, user_id)
            repo = HumanApiKeyRepository(s)
            _key, plaintext = await repo.create(member_id=member_id, expires_at=None)
            await s.commit()

            # 전환 시나리오 대리: 그사이 member.type이 바뀌었다고 가정(직접 UPDATE)
            await s.execute(
                Member.__table__.update().where(Member.id == member_id).values(type="agent")
            )
            await s.commit()

        async with Session() as s2:
            with pytest.raises(HTTPException) as ei:
                await _resolve_human_api_key(plaintext, s2)
            assert ei.value.status_code == 401
    finally:
        await engine.dispose()


# ─── AC2 핵심 — agent 전용 표면(x-agent-api-key 헤더) 서버 거부 ─────────────────


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_human_key_via_agent_header_does_not_authenticate():
    """⭐AC2 — hu_live_ 토큰을 x-agent-api-key 헤더로 보내면 agent로 인증되지 않는다(그
    헤더 분기는 sk_live_만 인식·hu_live_ 분기가 없어 자연 차단). Authorization 헤더도 없이
    보내면 결과적으로 401(Missing Authorization) — 「엉뚱하게 통과」가 없다는 게 핵심."""
    from fastapi import HTTPException
    from app.dependencies.auth import get_current_user
    from app.repositories.human_api_key import HumanApiKeyRepository

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_user(s)
            member_id = await _seed_human_member(s, org_id, user_id)
            repo = HumanApiKeyRepository(s)
            _key, plaintext = await repo.create(member_id=member_id, expires_at=None)
            await s.commit()

        with pytest.raises(HTTPException) as ei:
            await get_current_user(credentials=None, x_agent_api_key=plaintext, x_mcp_transport=None)
        assert ei.value.status_code == 401
        assert "Missing Authorization" in str(ei.value.detail)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_human_key_via_authorization_bearer_dispatches_to_resolver():
    """음성대조 — 같은 hu_live_ 접두사를 «정상 경로»(Authorization: Bearer)로 보내면
    _resolve_human_api_key로 정상 디스패치된다. AC2 테스트가 "hu_live_는 아무 데서도 인증
    안 됨"이 아니라 "agent 전용 표면(x-agent-api-key 헤더)에서만 거부"임을 대조로 고정.

    실 DB 왕복(_resolve_human_api_key 자체)은 위
    test_resolve_human_api_key_returns_jwt_shaped_context_no_api_key_id_claim이 이미 검증—
    이 테스트는 «디스패치 배선»만(get_current_user가 hu_live_를 올바른 resolver로 보내는가).
    test_sse_conn_leak.py의 기존 관례(_resolve_api_key mock)와 동형 — get_current_user가
    쓰는 모듈 전역 async_session_factory는 테스트별 격리 이벤트루프와 안 맞아(실측: 같은
    파일 내 다른 realdb 테스트와 함께 돌리면 'Event loop is closed') 이 축은 실 DB 라운드
    트립이 아니라 mock으로 디스패치만 잰다."""
    from unittest.mock import AsyncMock, patch
    from fastapi.security import HTTPAuthorizationCredentials
    from app.dependencies import auth
    from app.dependencies.auth import AuthContext, get_current_user

    fake_ctx = AuthContext(
        user_id="u1", email=None,
        claims={"app_metadata": {"org_id": "o1", "human_api_key_id": "k1", "actor_type": "human"}},
        org_id="o1",
    )
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="hu_live_deadbeef")
    with patch.object(auth, "_resolve_human_api_key", new=AsyncMock(return_value=fake_ctx)) as mock_resolve:
        ctx = await get_current_user(credentials=creds, x_agent_api_key=None, x_mcp_transport=None)
    mock_resolve.assert_awaited_once()
    assert mock_resolve.await_args.args[0] == "hu_live_deadbeef"
    assert ctx is fake_ctx


# ─── 셀프서브 라우터 축 ────────────────────────────────────────────────────────


def _human_auth(user_id: uuid.UUID, org_id: uuid.UUID):
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(user_id), email=None,
        claims={"app_metadata": {"org_id": str(org_id)}}, org_id=str(org_id),
    )


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_router_create_list_revoke_self_serve():
    from app.routers.me import create_my_api_key, list_my_api_keys, revoke_my_api_key
    from app.schemas.human_api_key import CreateHumanApiKeyRequest

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            user_id = await _seed_user(s)
            await _seed_human_member(s, org_id, user_id)
            auth = _human_auth(user_id, org_id)

            created = await create_my_api_key(
                CreateHumanApiKeyRequest(name="my key", expires_at=None), session=s, auth=auth,
            )
            assert created.api_key.startswith("hu_live_")

            listed = await list_my_api_keys(session=s, auth=auth)
            assert len(listed) == 1
            assert listed[0].id == created.id

            result = await revoke_my_api_key(created.id, session=s, auth=auth)
            assert result == {"ok": True}
    finally:
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_router_cannot_revoke_other_humans_key():
    """음성대조 — 다른 휴먼의 키는 404(존재 여부 누설 없이)."""
    from fastapi import HTTPException
    from app.routers.me import create_my_api_key, revoke_my_api_key
    from app.schemas.human_api_key import CreateHumanApiKeyRequest

    engine, Session = await _realdb_session()
    try:
        async with Session() as s:
            org_id = await _seed_org(s)
            owner_user_id = await _seed_user(s, email="owner1940@example.com")
            await _seed_human_member(s, org_id, owner_user_id, name="Owner")
            owner_auth = _human_auth(owner_user_id, org_id)
            created = await create_my_api_key(
                CreateHumanApiKeyRequest(expires_at=None), session=s, auth=owner_auth,
            )

            intruder_user_id = await _seed_user(s, email="intruder1940@example.com")
            await _seed_human_member(s, org_id, intruder_user_id, name="Intruder")
            intruder_auth = _human_auth(intruder_user_id, org_id)

            with pytest.raises(HTTPException) as ei:
                await revoke_my_api_key(created.id, session=s, auth=intruder_auth)
            assert ei.value.status_code == 404
    finally:
        await engine.dispose()
