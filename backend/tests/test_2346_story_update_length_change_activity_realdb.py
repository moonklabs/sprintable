"""story #2346 AC3(범위: stories 하나만 — docs.py·agent_runs.py는 미착수, 본문 참조) — 긴
텍스트 필드(description·acceptance_criteria)가 update_story로 바뀔 때 「이전 길이 → 이후
길이」를 기존 story_updated activity log의 context에 얹는다(신규 장치 0, 전문 스냅샷 아님).

양성 대조: 길이가 안 변하면(또는 그 필드가 아예 안 바뀌면) length_changes 자체가 안 남는다
— 매번 남으면 로그가 잡음이 된다.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("ab910000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("ab910000-0000-0000-0000-000000000002")
STORY = uuid.UUID("ab910000-0000-0000-0000-000000000003")
AGENT_IN = uuid.UUID("ab910000-0000-0000-0000-0000000000a1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _auth() -> "AuthContext":
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(AGENT_IN), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(ORG),
    )


async def _seed(s, initial_description: str) -> None:
    for sql in [
        f"DELETE FROM activity_logs WHERE org_id='{ORG}'",
        f"DELETE FROM stories WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','2346SD','s2346-org','free')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ}','{ORG}','P','none')",
        f"INSERT INTO members (id,org_id,type,name) VALUES ('{AGENT_IN}','{ORG}','agent','AgentIn')",
        f"INSERT INTO project_access (project_id,member_id,permission) VALUES ('{PROJ}','{AGENT_IN}','granted')",
    ]:
        await s.execute(text(sql))
    await s.execute(
        text(
            "INSERT INTO stories (id,org_id,project_id,title,status,priority,description) "
            "VALUES (:id,:org,:proj,'test story','backlog','medium',:desc)"
        ),
        {"id": STORY, "org": ORG, "proj": PROJ, "desc": initial_description},
    )
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _fetch_latest_story_updated_context(Session):
    async with Session() as s:
        row = (
            await s.execute(
                text(
                    "SELECT context FROM activity_logs WHERE org_id=:org AND action='story_updated' "
                    "ORDER BY created_at DESC LIMIT 1"
                ),
                {"org": ORG},
            )
        ).scalar_one_or_none()
        return row


@pytest.mark.anyio
async def test_shrinking_description_records_before_after_length():
    """AC3 핵심 — 3619자 → 437자 같은 급감이 story_updated activity의 context.length_changes에
    남는지(오늘 실제 사고 재현 규모)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        long_desc = "x" * 3619
        async with Session() as s:
            await _seed(s, long_desc)

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            bg = BackgroundTasks()
            short_desc = "y" * 437
            # AC7 게이트(50% 이상 급감 차단)가 이 크기의 축소를 막으므로 allow_shrink=true로
            # 명시 승인 — 이 테스트는 AC3(length_changes 기록) 검증이지 AC7 게이트 검증이 아니다.
            await update_story(
                STORY, StoryUpdate(description=short_desc, allow_shrink=True), bg, repo=repo, db=s, auth=_auth(),
            )
            await bg()

        context = await _fetch_latest_story_updated_context(Session)
        assert context is not None, "story_updated activity가 안 남음"
        assert context["length_changes"]["description"] == {"before": 3619, "after": 437}
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_unchanged_length_does_not_pollute_the_log():
    """양성 대조 — description을 같은 길이의 다른 텍스트로 바꾸면 length_changes 자체가
    안 남는다(매번 남으면 잡음)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        original = "a" * 100
        async with Session() as s:
            await _seed(s, original)

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            bg = BackgroundTasks()
            same_length_different_text = "b" * 100
            await update_story(
                STORY, StoryUpdate(description=same_length_different_text), bg, repo=repo, db=s, auth=_auth(),
            )
            await bg()

        context = await _fetch_latest_story_updated_context(Session)
        assert context is not None
        assert "length_changes" not in context, f"길이가 안 변했는데 기록됨(잡음): {context}"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_untouched_field_not_included_even_if_other_field_changes():
    """양성 대조 — description은 안 건드리고 title만 바꾸면, description은 length_changes에
    안 실린다(건드린 필드만 잰다)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, "unchanged description")

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            bg = BackgroundTasks()
            await update_story(
                STORY, StoryUpdate(title="new title"), bg, repo=repo, db=s, auth=_auth(),
            )
            await bg()

        context = await _fetch_latest_story_updated_context(Session)
        assert context is not None
        assert "length_changes" not in context, f"안 건드린 필드가 기록됨: {context}"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_ac7_shrink_over_50_percent_blocked_without_flag():
    """AC7(2026-07-30, PO 판정 — 사람 세기에서 기계 게이트로 격상) 핵심 — description이
    50% 이상 줄면 allow_shrink 없이는 400. 오늘 실제 3건 사고(전부 -80%대) 재현 규모."""
    from fastapi import HTTPException
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        long_desc = "x" * 3619
        async with Session() as s:
            await _seed(s, long_desc)

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            bg = BackgroundTasks()
            short_desc = "y" * 437  # -88%, 오늘 #2268 사고와 동일 규모
            with pytest.raises(HTTPException) as ei:
                await update_story(
                    STORY, StoryUpdate(description=short_desc), bg, repo=repo, db=s, auth=_auth(),
                )
            assert ei.value.status_code == 400
            assert "3619" in ei.value.detail and "437" in ei.value.detail

        # 봉인 — 거부됐으니 원본이 그대로 살아 있어야 한다(부분 적용 없음).
        async with Session() as s:
            row = (await s.execute(
                text("SELECT description FROM stories WHERE id=:i"), {"i": STORY}
            )).scalar_one()
            assert row == long_desc, "거부됐는데 description이 바뀜(부분 적용 회귀)"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_ac7_shrink_with_allow_shrink_flag_passes():
    """AC7 — allow_shrink=true로 명시 승인하면 같은 급감도 통과한다(정당한 축약 경로)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        long_desc = "x" * 3619
        async with Session() as s:
            await _seed(s, long_desc)

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            bg = BackgroundTasks()
            short_desc = "y" * 437
            resp = await update_story(
                STORY, StoryUpdate(description=short_desc, allow_shrink=True), bg, repo=repo, db=s, auth=_auth(),
            )
            assert resp.description == short_desc
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_ac7_small_shrink_under_threshold_not_blocked():
    """양성 대조 — 50% 미만 축소(정상적인 편집 범위)는 플래그 없이도 통과한다(잡음 방지)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        original = "x" * 100
        async with Session() as s:
            await _seed(s, original)

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            bg = BackgroundTasks()
            slightly_shorter = "y" * 60  # -40%, 임계(50%) 밑
            resp = await update_story(
                STORY, StoryUpdate(description=slightly_shorter), bg, repo=repo, db=s, auth=_auth(),
            )
            assert resp.description == slightly_shorter
    finally:
        await eng.dispose()
