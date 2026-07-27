"""story #2206(까심 인가 전수 스윕 A급·오르테가 확定): `GET /stories/{id}/comments`·
`GET /stories/{id}/activities` 가 org_id 조건 자체 없이 `StoryComment.story_id == id`
/`StoryActivity.story_id == id` 뿐이었다 — `_repo: StoryRepository = Depends(_get_repo)`
가 주입만 되고 쿼리엔 안 쓰이는 함정(호출자의 org 멤버십은 검증되지만, "그 story 가 실제로
그 org 소속인지"는 전혀 검증 안 됨). 어느 org 멤버든 story UUID 만 알면 다른 org 의
댓글·활동이 읽혔다.

처방 = GET /stories/{id}(get_story) 의 형제 가드(``repo.get(id)`` org-scope 404 +
``_assert_story_project_access`` project-scope 403)를 그대로 재사용. 새 규칙 발명 0.

⛔이 파일은 **결함이 있던 조건**(다른 org 의 human 이 그 story UUID 를 안다)으로 걸어야
하는 회귀 가드다 — 같은 org 픽스처만으로는 이 결함을 못 잡는다. 라이브 실행(실제 배포
시스템의 남의 org 데이터 조회)으로 갭을 확認하지 않는다 — 격리된 로컬 throwaway realdb에서
라우터 함수를 직접 호출한다(StoryRepository 를 attacker 의 org_id 로 수동 구성 — FastAPI
의존성 주입 경유 없이 `_get_repo` 가 만드는 것과 동일한 객체를 재현).
"""
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

VICTIM_ORG = uuid.UUID("d2206000-0000-0000-0000-000000000001")
VICTIM_PROJ = uuid.UUID("d2206000-0000-0000-0000-000000000002")
STORY = uuid.UUID("d2206000-0000-0000-0000-000000000003")

ATTACKER_ORG = uuid.UUID("d2206000-0000-0000-0000-0000000000a1")
ATTACKER_USER = uuid.UUID("d2206000-0000-0000-0000-0000000000a2")

VICTIM_MEMBER = uuid.UUID("d2206000-0000-0000-0000-000000000004")


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _attacker_auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(user_id=str(ATTACKER_USER), email=None, claims={}, org_id=str(ATTACKER_ORG))


async def _seed(s):
    """VICTIM_ORG 에 story 1건 + 댓글 1건 + 활동 1건. ATTACKER_ORG 는 완전히 별개
    (VICTIM 과 아무 관계도 없음 — project_access·team_member 어느 것도 안 만든다·바로
    이게 #2206 이 막아야 하는 축)."""
    from app.models.pm import Story, StoryActivity, StoryComment

    for sql in [
        f"DELETE FROM story_comments WHERE org_id='{VICTIM_ORG}'",
        f"DELETE FROM story_activities WHERE org_id='{VICTIM_ORG}'",
        f"DELETE FROM stories WHERE org_id IN ('{VICTIM_ORG}','{ATTACKER_ORG}')",
        f"DELETE FROM projects WHERE org_id IN ('{VICTIM_ORG}','{ATTACKER_ORG}')",
        # org_members·users 는 organizations DELETE 로 cascade 안 됨 — 여러 테스트가 같은
        # VICTIM_MEMBER id 로 재시딩하므로 명시 정리(테스트 순서·재실행 무관하게 항상 clean-slate).
        f"DELETE FROM org_members WHERE org_id='{VICTIM_ORG}'",
        f"DELETE FROM users WHERE id='{VICTIM_MEMBER}'",
        f"DELETE FROM organizations WHERE id IN ('{VICTIM_ORG}','{ATTACKER_ORG}')",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES "
        f"('{VICTIM_ORG}','Victim','d2206-victim','free'),"
        f"('{ATTACKER_ORG}','Attacker','d2206-attacker','free')",
        f"INSERT INTO projects (id,org_id,name,slug) VALUES ('{VICTIM_PROJ}','{VICTIM_ORG}','P','proj-victim')",
    ]:
        await s.execute(text(sql))
    story = Story(id=STORY, org_id=VICTIM_ORG, project_id=VICTIM_PROJ, title="비밀 스토리", status="backlog")
    s.add(story)
    await s.flush()
    s.add(StoryComment(
        id=uuid.uuid4(), org_id=VICTIM_ORG, story_id=STORY, project_id=VICTIM_PROJ,
        content="타org 에 새면 안 되는 댓글", created_by=VICTIM_MEMBER,
    ))
    s.add(StoryActivity(
        id=uuid.uuid4(), org_id=VICTIM_ORG, story_id=STORY, project_id=VICTIM_PROJ,
        activity_type="status_changed", created_by=VICTIM_MEMBER,
    ))
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


@pytest.mark.anyio
async def test_list_comments_cross_org_404_not_leaked():
    from app.repositories.story import StoryRepository
    from app.routers.stories import list_comments
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            # _get_repo 가 만드는 것과 동일한 객체를 attacker 의 org_id 로 수동 구성 —
            # FastAPI Depends 경유 없이 라우터 함수를 직접 호출(라이브 HTTP 무접촉).
            attacker_repo = StoryRepository(s, ATTACKER_ORG)
            with pytest.raises(HTTPException) as ei:
                await list_comments(
                    id=STORY, limit=20, cursor=None, db=s, repo=attacker_repo, auth=_attacker_auth(),
                )
            assert ei.value.status_code == 404
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_list_activities_cross_org_404_not_leaked():
    from app.repositories.story import StoryRepository
    from app.routers.stories import list_activities
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
        async with Session() as s:
            attacker_repo = StoryRepository(s, ATTACKER_ORG)
            with pytest.raises(HTTPException) as ei:
                await list_activities(id=STORY, limit=20, db=s, repo=attacker_repo, auth=_attacker_auth())
            assert ei.value.status_code == 404
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_list_comments_same_org_project_member_still_works():
    """회귀 없음 확認 — 정당한(같은 org, project 접근 O) 휴먼은 그대로 조회된다."""
    from app.repositories.story import StoryRepository
    from app.dependencies.auth import AuthContext
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            for sql in [
                f"INSERT INTO users (id,email,hashed_password,display_name,is_active,email_verified,"
                f"login_fail_count,totp_enabled,totp_fail_count) VALUES "
                f"('{VICTIM_MEMBER}','viewer@d2206.test','x','V',true,true,0,false,0)",
                f"INSERT INTO org_members (id,org_id,user_id,role) VALUES "
                f"(gen_random_uuid(),'{VICTIM_ORG}','{VICTIM_MEMBER}','owner')",
            ]:
                await s.execute(text(sql))
            await s.commit()
        async with Session() as s:
            from app.routers.stories import list_comments
            repo = StoryRepository(s, VICTIM_ORG)
            auth = AuthContext(user_id=str(VICTIM_MEMBER), email=None, claims={}, org_id=str(VICTIM_ORG))
            out = await list_comments(id=STORY, limit=20, cursor=None, db=s, repo=repo, auth=auth)
        assert len(out) == 1
        assert out[0].content == "타org 에 새면 안 되는 댓글"
    finally:
        await eng.dispose()
