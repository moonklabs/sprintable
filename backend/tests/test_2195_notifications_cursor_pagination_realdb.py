"""story #2195 — GET /api/v2/notifications(인박스 페이지 기본 탭)가 하드코딩 limit=50 +
커서 없음으로 51번째부터 조용히 잘렸다. #2231 정본 규약 A(limit+1 오버페치 +
has_more/next_cursor body meta, 참조 구현: conversations.py::list_messages)를 적용한다.

이 테스트는 "두 번째 페이지가 첫 페이지와 다른 행을 반환하는 것"을 실 PG로 증명한다
(#2231 AC3 · #2195 AC2 요구사항 — 200 응답만으로 갈음 금지). 5건을 심어 limit=2로
3페이지를 다 넘겨 합집합이 원본 5건과 정확히 일치하는 것(누락도 중복도 없음)까지 본다.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d2195000-0000-0000-0000-000000000010")
USER = uuid.UUID("d2195000-0000-0000-0000-000000000011")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(USER), email=None,
        claims={"app_metadata": {"org_id": str(ORG)}},
        org_id=str(ORG),
    )


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _clean(s):
    for sql in [
        f"DELETE FROM notifications WHERE org_id='{ORG}'",
        f"DELETE FROM users WHERE id='{USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed(s, n: int) -> list[uuid.UUID]:
    """org_id·user_id 하나에 n건의 Notification을 1초 간격(오래된 것부터)으로 심는다.
    반환값은 «최신순(내림차순)» — 서버가 실제로 정렬하는 순서와 같은 순서로 검증하기 위함."""
    await _clean(s)
    await s.execute(text(
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d2195-org','free')"
    ))
    await s.execute(text(
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{USER}','d2195@d2195.test','x','D2195',true,true,0,false,0)"
    ))
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    ids = []
    for i in range(n):
        nid = uuid.uuid4()
        ids.append(nid)
        created_at = base + timedelta(seconds=i)
        await s.execute(text(
            f"INSERT INTO notifications (id,org_id,user_id,type,title,is_read,created_at) VALUES "
            f"('{nid}','{ORG}','{USER}','probe_event','notif-{i}',false,'{created_at.isoformat()}')"
        ))
    await s.commit()
    return list(reversed(ids))  # newest-first, matches server ORDER BY created_at DESC


@pytest.mark.anyio
async def test_second_page_returns_different_rows_than_first_realdb():
    """AC2/AC3 핵심 — page1과 page2가 겹치지 않고, 합쳐서 원본과 정확히 일치한다."""
    from app.routers.notifications import list_notifications

    eng, Session = await _engine()
    try:
        async with Session() as s:
            newest_first = await _seed(s, n=5)

        async with Session() as s:
            from app.repositories.notification import NotificationRepository
            repo = NotificationRepository(s, ORG)
            page1 = await list_notifications(
                unread=None, is_read=None, limit=2, before=None,
                db=s, auth=_auth(), repo=repo,
            )
        assert [n.id for n in page1["data"]] == newest_first[0:2]
        assert page1["meta"]["has_more"] is True
        assert page1["meta"]["next_cursor"] is not None

        async with Session() as s:
            from app.repositories.notification import NotificationRepository
            repo = NotificationRepository(s, ORG)
            page2 = await list_notifications(
                unread=None, is_read=None, limit=2, before=page1["meta"]["next_cursor"],
                db=s, auth=_auth(), repo=repo,
            )
        page2_ids = [n.id for n in page2["data"]]
        assert page2_ids == newest_first[2:4], "page2가 page1과 다른 행을 반환해야 한다(#2195 AC2)"
        assert not (set(page2_ids) & {n.id for n in page1["data"]}), "page1·page2 겹침 — 커서가 안 전진함"
        assert page2["meta"]["has_more"] is True

        async with Session() as s:
            from app.repositories.notification import NotificationRepository
            repo = NotificationRepository(s, ORG)
            page3 = await list_notifications(
                unread=None, is_read=None, limit=2, before=page2["meta"]["next_cursor"],
                db=s, auth=_auth(), repo=repo,
            )
        page3_ids = [n.id for n in page3["data"]]
        assert page3_ids == newest_first[4:5]
        assert page3["meta"]["has_more"] is False
        assert page3["meta"]["next_cursor"] is None

        all_ids = [n.id for n in page1["data"]] + page2_ids + page3_ids
        assert all_ids == newest_first, "3페이지 합집합이 원본 5건과 순서까지 정확히 일치해야 한다(누락·중복 0)"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_no_cursor_first_page_unaffected_when_under_limit_realdb():
    """음성대조 — 총량이 limit 이하면 has_more=False·next_cursor=None(과잉 페이지네이션 아님)."""
    from app.routers.notifications import list_notifications
    from app.repositories.notification import NotificationRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            seeded = await _seed(s, n=3)

        async with Session() as s:
            repo = NotificationRepository(s, ORG)
            page = await list_notifications(
                unread=None, is_read=None, limit=50, before=None,
                db=s, auth=_auth(), repo=repo,
            )
        assert [n.id for n in page["data"]] == seeded
        assert page["meta"]["has_more"] is False
        assert page["meta"]["next_cursor"] is None
    finally:
        await eng.dispose()
