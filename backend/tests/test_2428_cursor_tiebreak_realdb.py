"""story #2428 — cursor 페이지네이션이 `created_at` 단독 정렬/커서였던 4곳(stories.py::
list_comments·list_activities·notifications.py::list_notifications·conversations.py::
list_messages ×2)에서, 같은 `created_at`을 가진 두 행이 페이지 경계에 걸치면 행이
누락되거나 중복될 수 있었다 — docs.py(#2191)·backlinks.py(#1994)가 각자 발견해 각자
고친 결함과 동형인데, `#2231`이 "정본"으로 지목한 이 넷엔 한 번도 안 돌아갔다.

이 테스트는 그 정확한 시나리오를 실 Postgres로 재현한다: `created_at`이 완전히 같은 두
행을 만들어 `limit=1` 페이지 경계에 걸치게 하고, (created_at, id) 복합 cursor로 넘어간
뒤엔 누락/중복 없이 전부 도달 가능한지 확認한다.

positive control(AC4류): 이 파일은 notifications 도메인에서 실측한다 — 아래
`test_tie_break_page_boundary_no_drop_or_duplicate_realdb`가 통과하는 것 자체가
"수정 후" 증거다. "수정 전"(단독 created_at cursor) 재현은 `_legacy_single_column_query`가
별도로 흉내내 같은 조건에서 실제로 행이 드롭되는 것을 보인다(#2412 스타일 — 코드를
되돌리는 대신, 옛 쿼리 형태를 로컬 함수로 나란히 재현해 대조).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d2428000-0000-0000-0000-000000000001")
USER = uuid.UUID("d2428000-0000-0000-0000-000000000002")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _clean(s):
    await s.execute(text(f"DELETE FROM notifications WHERE org_id='{ORG}'"))
    await s.commit()


async def _seed_tie(s) -> list[uuid.UUID]:
    """3건: 최신 둘(A·B)이 «완전히 같은 created_at»으로 경계에 걸치고, 하나(C)는 더 오래됨.
    삽입 순서는 의도적으로 A·B·C 순(정렬과 무관하게 섞음 — id 자체는 uuid4라 정렬 순서를
    예측할 수 없으므로, 어느 쪽이 A/B인지는 실제 (created_at,id) 정렬 결과로 판정한다)."""
    await _clean(s)
    tie_at = datetime(2026, 8, 1, 12, 0, 0, tzinfo=timezone.utc)
    older_at = tie_at - timedelta(days=1)
    ids = {}
    for label, ts in (("A", tie_at), ("B", tie_at), ("C", older_at)):
        nid = uuid.uuid4()
        ids[label] = nid
        await s.execute(text(
            f"INSERT INTO notifications (id,org_id,user_id,type,title,is_read,created_at) VALUES "
            f"('{nid}','{ORG}','{USER}','test','{label}',false,'{ts.isoformat()}')"
        ))
    await s.commit()
    return ids


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(USER), email=None, claims={}, org_id=str(ORG))


@pytest.mark.anyio
async def test_tie_break_page_boundary_no_drop_or_duplicate_realdb():
    """AC 본체 — limit=1로 강제 페이지네이션, A/B(동률) 둘 다 빠짐/중복 없이 나와야 한다."""
    from app.routers.notifications import list_notifications
    from app.repositories.notification import NotificationRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed_tie(s)
        by_id = {v: k for k, v in ids.items()}

        seen_labels: list[str] = []
        cursor = None
        for _ in range(5):  # 안전 상한(무한루프 방지) — 실제로는 3페이지면 끝나야 한다
            async with Session() as s:
                repo = NotificationRepository(s, ORG)
                page = await list_notifications(
                    unread=None, is_read=None, limit=1, before=cursor,
                    db=s, auth=_auth(), repo=repo,
                )
            assert len(page["data"]) == 1
            seen_labels.append(by_id[page["data"][0].id])
            if not page["meta"]["has_more"]:
                assert page["meta"]["next_cursor"] is None
                break
            cursor = page["meta"]["next_cursor"]
        else:
            pytest.fail("5페이지 넘게 끝나지 않음 — 무한루프(중복 재방문) 의심")

        assert sorted(seen_labels) == ["A", "B", "C"], (
            f"동률 경계에서 행이 빠지거나 중복됐다: {seen_labels}"
        )
        assert len(seen_labels) == len(set(seen_labels)), f"중복 방문: {seen_labels}"
    finally:
        async with Session() as s:
            await _clean(s)
        await eng.dispose()


async def _legacy_single_column_query(session, org_id, user_id, limit, before_dt):
    """story #2428 — 수정 «전» 쿼리 형태를 로컬로 재현(코드를 되돌리지 않고 나란히 비교).
    routers/notifications.py가 실제로 갖고 있던 형태: `created_at DESC` 단독 정렬 + 단독
    `created_at < before` cursor."""
    from app.models.notification import Notification

    q = select(Notification).where(Notification.org_id == org_id, Notification.user_id == user_id)
    if before_dt is not None:
        q = q.where(Notification.created_at < before_dt)
    q = q.order_by(Notification.created_at.desc()).limit(limit)
    result = await session.execute(q)
    return list(result.scalars().all())


@pytest.mark.anyio
async def test_legacy_single_column_cursor_actually_drops_a_row_realdb():
    """positive control — «수정 전» 형태가 실제로 이 시나리오에서 행을 드롭시키는 것을
    직접 재현. 이게 없으면 위 test가 통과하는 이유가 "애초에 안 깨지는 시나리오라서"인지
    "진짜로 고쳐서"인지 구분이 안 된다."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            ids = await _seed_tie(s)
        by_id = {v: k for k, v in ids.items()}

        async with Session() as s:
            page1 = await _legacy_single_column_query(s, ORG, USER, limit=1, before_dt=None)
        assert len(page1) == 1
        page1_label = by_id[page1[0].id]
        assert page1_label in ("A", "B")  # 동률 둘 중 하나(DB가 임의로 고른 순서)

        # 레거시 커서: created_at.isoformat()만 — id 정보 없음.
        legacy_cursor = page1[0].created_at

        async with Session() as s:
            page2 = await _legacy_single_column_query(s, ORG, USER, limit=1, before_dt=legacy_cursor)
        page2_labels = [by_id[r.id] for r in page2]

        # 레거시 형태의 결함 재현: created_at < cursor는 "같은 created_at"인 동률 짝을
        # 자동으로 건너뛴다 — page2는 동률 짝(A/B 중 나머지)이 아니라 곧장 C로 간다.
        assert "C" in page2_labels
        remaining_tied = {"A", "B"} - {page1_label}
        assert not (remaining_tied & set(page2_labels)), (
            f"예상대로라면 동률 짝({remaining_tied})이 여기서 «드롭»되는 게 결함 재현인데 "
            f"실제로 나왔다({page2_labels}) — 이 테스트 자체가 시나리오를 잘못 재현했을 수 있다."
        )
    finally:
        async with Session() as s:
            await _clean(s)
        await eng.dispose()


@pytest.mark.anyio
async def test_no_tie_normal_data_page_result_unaffected_realdb():
    """음성대조 — created_at이 전부 다른 평범한 데이터에선 신구 방식 결과가 같아야 한다."""
    from app.routers.notifications import list_notifications
    from app.repositories.notification import NotificationRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _clean(s)
            base = datetime(2026, 7, 1, tzinfo=timezone.utc)
            ids = []
            for i in range(4):
                nid = uuid.uuid4()
                ids.append(nid)
                ts = base + timedelta(hours=i)
                await s.execute(text(
                    f"INSERT INTO notifications (id,org_id,user_id,type,title,is_read,created_at) VALUES "
                    f"('{nid}','{ORG}','{USER}','test','n{i}',false,'{ts.isoformat()}')"
                ))
            await s.commit()
        newest_first = list(reversed(ids))

        async with Session() as s:
            repo = NotificationRepository(s, ORG)
            page = await list_notifications(
                unread=None, is_read=None, limit=10, before=None, db=s, auth=_auth(), repo=repo,
            )
        got_ids = [d.id for d in page["data"]]
        assert got_ids == newest_first
        assert page["meta"]["has_more"] is False
    finally:
        async with Session() as s:
            await _clean(s)
        await eng.dispose()
