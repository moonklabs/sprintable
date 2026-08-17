"""story #2477: Free 좌석 cap 우회 — pending invite 미집계 + accept 재검증 부재 fix.

AC①: 초대 «생성» 시 cap 검사 = 현재 멤버 + pending invite 합.
AC②: 초대 «수락» 시 재검증 — 수락으로 cap 초과되면 거부.
AC③: 동시 수락 레이스 방어(advisory xact lock으로 원자적 직렬화).
AC④: check_member_invite_limit docstring "5명" → "3명" 갱신.
AC⑤: 양성대조 — «2명+초대5 전부수락» 시나리오가 실제로 거부됨(우회 불가) 실증.

AC①④는 mock 기반 unit(빠름, 항상 실행). AC②③⑤는 real-DB 통합(asyncio.gather로 5개
독립 세션이 진짜로 동시에 accept를 다투게 해 advisory lock의 실질적 직렬화 효과를
증명 — mock 세션으로는 락의 존재만 확인 가능하지 실제 레이스 방어는 증명 못 함).
DB env 없으면 skip.
"""
from __future__ import annotations

import inspect
import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── AC④: docstring 5명→3명 갱신 ─────────────────────────────────────────────

def test_check_member_invite_limit_docstring_says_3_not_5():
    from ee.plan_limits import check_member_invite_limit
    source = inspect.getsource(check_member_invite_limit)
    assert "5명" not in source
    assert "3명" in source


# ─── AC①: 생성 시점 cap = 현재 멤버 + pending invite 합 ─────────────────────

def test_check_member_invite_limit_counts_pending_invites_in_sql():
    """count SQL에 org_invites·pending·org_members 3요소가 합산 형태로 실재."""
    from ee.plan_limits import check_member_invite_limit
    source = inspect.getsource(check_member_invite_limit)
    assert "org_invites" in source
    assert "pending" in source
    assert "org_members" in source


@pytest.mark.anyio
async def test_check_member_invite_limit_rejects_when_members_plus_pending_at_cap():
    """현재 멤버+pending 합이 cap(3) 이상이면 생성 시점에 402."""
    from fastapi import HTTPException
    from ee.plan_limits import check_member_invite_limit

    mock_session = AsyncMock()
    tier_result = MagicMock()
    tier_result.first.return_value = ("free",)
    count_result = MagicMock()
    count_result.scalar.return_value = 3  # 2 members + 1 pending = 3 = cap
    mock_session.execute = AsyncMock(side_effect=[tier_result, count_result])

    with pytest.raises(HTTPException) as exc_info:
        await check_member_invite_limit(mock_session, uuid.uuid4())
    assert exc_info.value.status_code == 402
    assert exc_info.value.detail["code"] == "PLAN_LIMIT_EXCEEDED"


@pytest.mark.anyio
async def test_check_member_invite_limit_passes_when_under_cap():
    """현재 멤버+pending 합이 cap 미만이면 통과(예외 없음)."""
    from ee.plan_limits import check_member_invite_limit

    mock_session = AsyncMock()
    tier_result = MagicMock()
    tier_result.first.return_value = ("free",)
    count_result = MagicMock()
    count_result.scalar.return_value = 2  # 1 member + 1 pending = 2 < 3
    mock_session.execute = AsyncMock(side_effect=[tier_result, count_result])

    await check_member_invite_limit(mock_session, uuid.uuid4())  # 예외 없어야 함


# ─── AC②: accept-time 재검증 함수 존재 + 402 거부 (mock, 락 존재만 확인) ────

def test_check_member_accept_limit_exists():
    from ee.plan_limits import check_member_accept_limit
    source = inspect.getsource(check_member_accept_limit)
    assert "max_members" in source
    assert "_plan_limit_error" in source or "raise" in source


def test_accept_calls_advisory_lock_before_cap_check_in_source():
    """accept() 소스에 pg_advisory_xact_lock이 check_member_accept_limit보다 먼저 나온다
    (락 없이 재검증만 하면 TOCTOU 레이스가 그대로 남는다 — 순서 자체가 계약)."""
    from app.repositories.org_invite import OrgInviteRepository
    source = inspect.getsource(OrgInviteRepository.accept)
    lock_pos = source.find("pg_advisory_xact_lock")
    check_pos = source.find("check_member_accept_limit")
    assert lock_pos != -1
    assert check_pos != -1
    assert lock_pos < check_pos


@pytest.mark.anyio
async def test_accept_rejects_when_at_cap_ee_on():
    """EE on + 현재 멤버수가 cap(3) 이상이면 accept()가 402로 거부(mock)."""
    from fastapi import HTTPException
    from app.repositories.org_invite import OrgInviteRepository

    org_id = uuid.uuid4()
    invite = MagicMock()
    invite.status = "pending"
    invite.organization_id = org_id
    invite.role = "member"
    invite.email = "invitee@example.com"
    invite.expires_at = datetime.now(timezone.utc) + timedelta(days=3)

    invite_result = MagicMock()
    invite_result.scalar_one_or_none.return_value = invite
    tier_result = MagicMock()
    tier_result.first.return_value = ("free",)
    count_result = MagicMock()
    count_result.scalar.return_value = 3  # 이미 cap

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[invite_result, MagicMock(), tier_result, count_result])

    repo = OrgInviteRepository(session)
    with patch("app.repositories.org_invite.settings") as mock_settings:
        mock_settings.is_ee_enabled = True
        with pytest.raises(HTTPException) as exc_info:
            await repo.accept(token="tok", user_id=uuid.uuid4(), user_email="invitee@example.com")
    assert exc_info.value.status_code == 402


@pytest.mark.anyio
async def test_accept_oss_skips_cap_check():
    """EE off(OSS)면 advisory lock/cap 재검증 자체를 안 함(ee import 없음) — 기존 동작 무회귀."""
    from app.repositories.org_invite import OrgInviteRepository

    org_id = uuid.uuid4()
    invite = MagicMock()
    invite.status = "pending"
    invite.organization_id = org_id
    invite.role = "member"
    invite.email = "invitee@example.com"
    invite.expires_at = datetime.now(timezone.utc) + timedelta(days=3)
    invite.project_ids = []

    invite_result = MagicMock()
    invite_result.scalar_one_or_none.return_value = invite
    om_id_result = MagicMock()
    om_id_result.scalar_one_or_none.return_value = uuid.uuid4()

    session = AsyncMock()
    # OSS 경로: invite 조회 → org_members upsert → om_id 재조회. 락/캡 쿼리 없음(2개 아닌 3개).
    session.execute = AsyncMock(side_effect=[invite_result, MagicMock(), om_id_result])
    session.flush = AsyncMock()

    repo = OrgInviteRepository(session)
    with patch("app.repositories.org_invite.settings") as mock_settings, \
            patch("app.services.agent_anchor_sync.ensure_human_member", new=AsyncMock()):
        mock_settings.is_ee_enabled = False
        result = await repo.accept(token="tok", user_id=uuid.uuid4(), user_email="invitee@example.com")
    assert result["ok"] is True


# ─── AC②③⑤: real-DB — 진짜 동시 수락 레이스 + 양성대조 ─────────────────────

pytestmark_realdb = pytest.mark.skipif(
    not _REAL_DB_URL, reason="real-DB URL(PARITY/ALEMBIC_DATABASE_URL) 미설정 — skip"
)


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


def _ee_on():
    from app.core.config import settings
    return patch.object(type(settings), "is_ee_enabled", property(lambda self: True))


@pytest.mark.anyio
@pytestmark_realdb
async def test_2_members_plus_5_invites_all_accept_concurrently_only_1_passes_cap():
    """AC⑤ 양성대조(실 PG): free org에 멤버 2명이 이미 있고 pending 초대 5개가 동시에
    수락되면(asyncio.gather, 5개 독립 세션·독립 커넥션) cap(3)을 넘길 수 있는 나머지
    4개는 거부되고 정확히 1개만 성공해야 한다(2+1=3=cap). advisory xact lock이 없다면
    5개 트랜잭션이 서로의 INSERT를 못 본 채 동시에 "아직 cap 안 참"을 보고 여러 개가
    동시에 통과할 수 있다 — 이게 바로 story #2477이 잡으려는 우회 그 자체."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.repositories.org_invite import OrgInviteRepository

    org_id = uuid.uuid4()
    existing_member_ids = [uuid.uuid4() for _ in range(2)]
    invitee_ids = [uuid.uuid4() for _ in range(5)]
    tokens = [f"race2477-{i}-{uuid.uuid4().hex[:8]}" for i in range(5)]

    engine = create_async_engine(_async_url(), pool_size=10, max_overflow=10)
    SessionLocal = async_sessionmaker(engine, expire_on_commit=False)

    async with SessionLocal() as s:
        await s.execute(text("DELETE FROM org_invites WHERE organization_id=:o"), {"o": str(org_id)})
        await s.execute(text("DELETE FROM org_members WHERE org_id=:o"), {"o": str(org_id)})
        await s.execute(
            text("DELETE FROM users WHERE id = ANY(:ids)"),
            {"ids": [str(i) for i in existing_member_ids + invitee_ids]},
        )
        await s.execute(text("DELETE FROM organizations WHERE id=:o"), {"o": str(org_id)})
        await s.execute(
            text("INSERT INTO organizations (id,name,slug,plan) VALUES (:o,'2477 Race Org',:slug,'free')"),
            {"o": str(org_id), "slug": f"race2477-{org_id.hex[:8]}"},
        )
        for uid in existing_member_ids + invitee_ids:
            await s.execute(
                text(
                    "INSERT INTO users (id,email,hashed_password,is_active)"
                    " VALUES (:id,:email,'x',true)"
                ),
                {"id": str(uid), "email": f"{uid}@race2477.test"},
            )
        for uid in existing_member_ids:
            await s.execute(
                text("INSERT INTO org_members (id,org_id,user_id,role) VALUES (:id,:o,:u,'member')"),
                {"id": str(uuid.uuid4()), "o": str(org_id), "u": str(uid)},
            )
        now = datetime.now(timezone.utc)
        for uid, tok in zip(invitee_ids, tokens):
            await s.execute(
                text(
                    "INSERT INTO org_invites"
                    " (id,organization_id,email,role,token,status,expires_at,project_ids)"
                    " VALUES (:id,:o,:email,'member',:tok,'pending',:exp,'[]'::jsonb)"
                ),
                {
                    "id": str(uuid.uuid4()), "o": str(org_id),
                    "email": f"{uid}@race2477.test", "tok": tok,
                    "exp": now + timedelta(days=7),
                },
            )
        await s.commit()

    async def _accept_one(user_id: uuid.UUID, token: str):
        async with SessionLocal() as sess:
            repo = OrgInviteRepository(sess)
            try:
                with _ee_on():
                    result = await repo.accept(
                        token=token, user_id=user_id, user_email=f"{user_id}@race2477.test"
                    )
                await sess.commit()
                return ("ok", result)
            except Exception as exc:  # noqa: BLE001 — 성공/실패 신호를 한 채널로 모으기 위함
                await sess.rollback()
                return ("err", exc)

    import asyncio
    outcomes = await asyncio.gather(*[
        _accept_one(uid, tok) for uid, tok in zip(invitee_ids, tokens)
    ])

    successes = [o for o in outcomes if o[0] == "ok"]
    failures = [o for o in outcomes if o[0] == "err"]

    assert len(successes) == 1, f"cap=3(기존2+신규1)인데 {len(successes)}건 통과 — 우회 발생: {outcomes}"
    assert len(failures) == 4
    for _, exc in failures:
        from fastapi import HTTPException
        assert isinstance(exc, HTTPException)
        assert exc.status_code == 402
        assert exc.detail["code"] == "PLAN_LIMIT_EXCEEDED"

    async with SessionLocal() as s:
        final_count = (await s.execute(
            text("SELECT COUNT(*) FROM org_members WHERE org_id=:o AND deleted_at IS NULL"),
            {"o": str(org_id)},
        )).scalar()
        assert final_count == 3, f"최종 멤버수는 정확히 cap(3)이어야: {final_count}"

    await engine.dispose()
