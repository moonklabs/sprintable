"""story #2247 — GET /api/v2/stories/{id}/activities 에 cursor 파라미터 자체가 없어
FE(story-detail-panel.tsx)의 「더보기」(핸들러+버튼 전부 이미 완성)가 원천적으로 도달
불가였다(#2231 표 CAPPED-NO-NEXT-PAGE). #2231 정본 규약 A(limit+1 오버페치 +
has_more/next_cursor body meta, 참조 구현: stories.py::list_comments — #2230)를
적용해 실제로 동작하게 한다. #2231 AC3(적용 엔드포인트 realdb 2페이지 «다름» 검증)의
검증 책임이 이 스토리로 왔다 — 아래 테스트가 그 책임을 진다.
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

ORG = uuid.UUID("d2247000-0000-0000-0000-000000000010")
PROJ = uuid.UUID("d2247000-0000-0000-0000-000000000011")
STORY = uuid.UUID("d2247000-0000-0000-0000-000000000012")
AUTHOR_USER = uuid.UUID("d2247000-0000-0000-0000-000000000013")
AUTHOR_MEMBER = uuid.UUID("d2247000-0000-0000-0000-000000000014")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(AUTHOR_USER), email=None,
        claims={"app_metadata": {"org_id": str(ORG)}},
        org_id=str(ORG),
    )


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _clean(s):
    for sql in [
        f"DELETE FROM story_activities WHERE org_id='{ORG}'",
        f"DELETE FROM stories WHERE id='{STORY}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE id='{PROJ}'",
        f"DELETE FROM users WHERE id='{AUTHOR_USER}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed(s, n: int) -> list[uuid.UUID]:
    await _clean(s)
    await s.execute(text(f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','O','d2247-org','free')"))
    await s.execute(text(
        f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
        f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
        f"('{AUTHOR_USER}','d2247@d2247.test','x','D2247',true,true,0,false,0)"
    ))
    await s.execute(text(f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P2247')"))
    await s.execute(text(
        f"INSERT INTO members (id,org_id,user_id,type,name,is_active) VALUES "
        f"('{AUTHOR_MEMBER}','{ORG}','{AUTHOR_USER}','human','D2247',true)"
    ))
    await s.execute(text(
        f"INSERT INTO project_access (id,project_id,member_id,role,permission) VALUES "
        f"(gen_random_uuid(),'{PROJ}','{AUTHOR_MEMBER}','member','granted')"
    ))
    await s.execute(text(
        f"INSERT INTO stories (id,org_id,project_id,title,status) VALUES "
        f"('{STORY}','{ORG}','{PROJ}','S','backlog')"
    ))
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    ids = []
    for i in range(n):
        aid = uuid.uuid4()
        ids.append(aid)
        created_at = base + timedelta(seconds=i)
        await s.execute(text(
            f"INSERT INTO story_activities (id,org_id,story_id,project_id,activity_type,"
            f"old_value,new_value,created_by,created_at) VALUES "
            f"('{aid}','{ORG}','{STORY}','{PROJ}','status_changed','backlog','in-progress',"
            f"'{AUTHOR_MEMBER}','{created_at.isoformat()}')"
        ))
    await s.commit()
    return list(reversed(ids))  # newest-first, matches server ORDER BY created_at DESC


@pytest.mark.anyio
async def test_second_page_returns_different_rows_realdb():
    from app.routers.stories import list_activities
    from app.repositories.story import StoryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            newest_first = await _seed(s, n=5)

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            page1 = await list_activities(id=STORY, limit=2, cursor=None, db=s, repo=repo, auth=_auth())
        assert [a.id for a in page1["data"]] == newest_first[0:2]
        assert page1["meta"]["has_more"] is True

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            page2 = await list_activities(
                id=STORY, limit=2, cursor=page1["meta"]["next_cursor"], db=s, repo=repo, auth=_auth(),
            )
        page2_ids = [a.id for a in page2["data"]]
        assert page2_ids == newest_first[2:4], "page2가 page1과 다른 행을 반환해야 한다(#2231 AC3 본체)"
        assert not (set(page2_ids) & {a.id for a in page1["data"]})

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            page3 = await list_activities(
                id=STORY, limit=2, cursor=page2["meta"]["next_cursor"], db=s, repo=repo, auth=_auth(),
            )
        assert [a.id for a in page3["data"]] == newest_first[4:5]
        assert page3["meta"]["has_more"] is False
        assert page3["meta"]["next_cursor"] is None
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_no_cursor_under_limit_has_more_false_realdb():
    from app.routers.stories import list_activities
    from app.repositories.story import StoryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            seeded = await _seed(s, n=3)

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            page = await list_activities(id=STORY, limit=20, cursor=None, db=s, repo=repo, auth=_auth())
        assert [a.id for a in page["data"]] == seeded
        assert page["meta"]["has_more"] is False
        assert page["meta"]["next_cursor"] is None
    finally:
        await eng.dispose()


class _FakeQuerySentinel:
    """#2540 CI 재현(오르테가군) — FastAPI Query(...) 객체처럼 str이 아니면서 truthy인 것을
    흉내낸다. list_activities를 FastAPI DI 없이 직접 호출하며 cursor= 를 누락하면 실제로
    이런 모양의 객체(파이썬 함수 기본값)가 들어온다."""
    default = None


@pytest.mark.anyio
async def test_non_string_truthy_cursor_treated_as_no_cursor_not_crash_realdb():
    from app.routers.stories import list_activities
    from app.repositories.story import StoryRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            seeded = await _seed(s, n=3)

        fake_sentinel = _FakeQuerySentinel()
        assert bool(fake_sentinel) is True  # 전제 확인 — truthy임

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            page = await list_activities(id=STORY, limit=20, cursor=fake_sentinel, db=s, repo=repo, auth=_auth())
        assert [a.id for a in page["data"]] == seeded, "커서 없음으로 취급돼 전체가 나와야 한다(크래시 아님)"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_invalid_cursor_format_400_realdb():
    from app.routers.stories import list_activities
    from app.repositories.story import StoryRepository
    from fastapi import HTTPException

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, n=1)

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            with pytest.raises(HTTPException) as ei:
                await list_activities(id=STORY, limit=20, cursor="not-a-date", db=s, repo=repo, auth=_auth())
            assert ei.value.status_code == 400
    finally:
        await eng.dispose()
