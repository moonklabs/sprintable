"""story #2254(그라운딩 doc e5bc0789, 2026-08-25) — 스토리 description/acceptance_criteria
append+1-depth 되돌리기 회귀가드.

핵심 검증축:
①description_append — 원자적 이어붙이기(기존값+개행2줄+append값), previous_description에
  이전값 스냅샷.
②plain+append 동시 지정 — 422 AMBIGUOUS_UPDATE_MODE.
③restore_description — previous_description↔description swap(되돌리기 자체도 되돌릴 수 있음).
④previous_description 없이 restore 시도 — 422 NOTHING_TO_RESTORE.
⑤restore는 shrink-guard를 우회한다(축소라도 allow_shrink 불요 — 명시적 의도된 행동).
⑥acceptance_criteria도 description과 대칭으로 동작(append).
⑦기존 plain full-replace 경로는 무회귀 — previous_description이 부수효과로 정확히 채워짐.
"""
from __future__ import annotations

import os
import uuid

import pytest
from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("22540000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("22540000-0000-0000-0000-000000000002")
STORY = uuid.UUID("22540000-0000-0000-0000-000000000003")
AGENT_IN = uuid.UUID("22540000-0000-0000-0000-0000000000a1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


def _auth():
    from app.dependencies.auth import AuthContext
    return AuthContext(
        user_id=str(AGENT_IN), email=None,
        claims={"app_metadata": {"api_key_id": str(uuid.uuid4())}}, org_id=str(ORG),
    )


async def _seed(s, *, description: str = "", acceptance_criteria: str = "",
                 previous_description: str | None = None) -> None:
    for sql in [
        f"DELETE FROM activity_logs WHERE org_id='{ORG}'",
        f"DELETE FROM stories WHERE org_id='{ORG}'",
        f"DELETE FROM project_access WHERE project_id='{PROJ}'",
        f"DELETE FROM members WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','2254SD','s2254-org','free')",
        f"INSERT INTO projects (id,org_id,name,violation_level) VALUES ('{PROJ}','{ORG}','P','none')",
        f"INSERT INTO members (id,org_id,type,name) VALUES ('{AGENT_IN}','{ORG}','agent','AgentIn')",
        f"INSERT INTO project_access (project_id,member_id,permission) VALUES ('{PROJ}','{AGENT_IN}','granted')",
    ]:
        await s.execute(text(sql))
    await s.execute(
        text(
            "INSERT INTO stories "
            "(id,org_id,project_id,title,status,priority,description,acceptance_criteria,"
            " previous_description,story_number) "
            "VALUES (:id,:org,:proj,'test story','backlog','medium',:desc,:ac,:prev_desc,2254)"
        ),
        {
            "id": STORY, "org": ORG, "proj": PROJ, "desc": description, "ac": acceptance_criteria,
            "prev_desc": previous_description,
        },
    )
    await s.commit()


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _fetch_story(Session):
    from app.models.pm import Story
    from sqlalchemy import select
    async with Session() as s:
        return (await s.execute(select(Story).where(Story.id == STORY))).scalar_one()


@pytest.mark.anyio
async def test_description_append_concatenates_atomically_and_snapshots_previous():
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, description="Original findings.")

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            bg = BackgroundTasks()
            await update_story(
                STORY, StoryUpdate(description_append="New appendix section."), bg,
                repo=repo, db=s, auth=_auth(),
            )
            await bg()

        story = await _fetch_story(Session)
        assert story.description == "Original findings.\n\nNew appendix section.", story.description
        assert story.previous_description == "Original findings."
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_plain_and_append_together_rejected_422():
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, description="Original.")

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            bg = BackgroundTasks()
            with pytest.raises(HTTPException) as exc_info:
                await update_story(
                    STORY, StoryUpdate(description="Replaced whole.", description_append="Also this."), bg,
                    repo=repo, db=s, auth=_auth(),
                )
            assert exc_info.value.status_code == 422
            assert exc_info.value.detail["code"] == "AMBIGUOUS_UPDATE_MODE"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_restore_description_swaps_current_and_previous():
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, description="Current value.", previous_description="Older value.")

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            bg = BackgroundTasks()
            await update_story(
                STORY, StoryUpdate(restore_description=True), bg, repo=repo, db=s, auth=_auth(),
            )
            await bg()

        story = await _fetch_story(Session)
        assert story.description == "Older value.", "restore가 previous_description으로 되돌리지 않음"
        assert story.previous_description == "Current value.", (
            "restore 자체도 되돌릴 수 있어야 한다(swap) — previous_*에 되돌리기 前 현재값이 남아야 함"
        )
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_restore_without_previous_value_rejected_422():
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, description="Only current, no history.")  # previous_description=None

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            bg = BackgroundTasks()
            with pytest.raises(HTTPException) as exc_info:
                await update_story(
                    STORY, StoryUpdate(restore_description=True), bg, repo=repo, db=s, auth=_auth(),
                )
            assert exc_info.value.status_code == 422
            assert exc_info.value.detail["code"] == "NOTHING_TO_RESTORE"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_restore_bypasses_shrink_guard_without_allow_shrink():
    """⑤ — restore는 명시적 의도(되돌리기)라 shrink-guard(#2346 AC7)를 우회한다. 여기서
    previous_description(50자)이 현재값(3000자)보다 훨씬 짧아 allow_shrink=false로도
    통과해야 한다(일반 plain 축소였다면 400으로 막혔을 크기)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        long_current = "x" * 3000
        short_previous = "y" * 50
        async with Session() as s:
            await _seed(s, description=long_current, previous_description=short_previous)

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            bg = BackgroundTasks()
            # allow_shrink 미지정(기본 False) — 그래도 restore는 통과해야 한다.
            await update_story(
                STORY, StoryUpdate(restore_description=True), bg, repo=repo, db=s, auth=_auth(),
            )
            await bg()

        story = await _fetch_story(Session)
        assert story.description == short_previous
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_acceptance_criteria_append_symmetric_with_description():
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, acceptance_criteria="AC1: base criterion.")

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            bg = BackgroundTasks()
            await update_story(
                STORY, StoryUpdate(acceptance_criteria_append="AC2: added criterion."), bg,
                repo=repo, db=s, auth=_auth(),
            )
            await bg()

        story = await _fetch_story(Session)
        assert story.acceptance_criteria == "AC1: base criterion.\n\nAC2: added criterion."
        assert story.previous_acceptance_criteria == "AC1: base criterion."
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_plain_full_replace_still_snapshots_previous_no_regression():
    """⑦ — 기존 plain full-replace 경로(append/restore 미사용)는 그대로 동작하되,
    previous_description이 부수효과로 정확히 채워진다(회귀 아님·의도된 확장)."""
    from app.repositories.story import StoryRepository
    from app.routers.stories import update_story
    from app.schemas.story import StoryUpdate

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s, description="Before replace.")

        async with Session() as s:
            repo = StoryRepository(s, ORG)
            bg = BackgroundTasks()
            await update_story(
                STORY, StoryUpdate(description="After replace."), bg, repo=repo, db=s, auth=_auth(),
            )
            await bg()

        story = await _fetch_story(Session)
        assert story.description == "After replace."
        assert story.previous_description == "Before replace."
    finally:
        await eng.dispose()
