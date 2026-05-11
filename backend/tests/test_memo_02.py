"""MEMO-02: entity embed 서버사이드 파싱 테스트."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
MEMO_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
DOC_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


# ─── _parse_entity_embeds 단위 테스트 ─────────────────────────────────────────

def test_parse_entity_embeds_story():
    """(entity:story:uuid) 패턴 파싱."""
    from app.routers.memos import _parse_entity_embeds
    content = f"스토리 참조: [S-01](entity:story:{STORY_ID})"
    embeds = _parse_entity_embeds(content)
    assert len(embeds) == 1
    assert embeds[0].entity_type == "story"
    assert embeds[0].entity_id == STORY_ID


def test_parse_entity_embeds_multiple_types():
    """story + doc 복합 파싱."""
    from app.routers.memos import _parse_entity_embeds
    content = (
        f"[스토리](entity:story:{STORY_ID}) 관련 "
        f"[문서](entity:doc:{DOC_ID})"
    )
    embeds = _parse_entity_embeds(content)
    assert len(embeds) == 2
    types = {e.entity_type for e in embeds}
    assert types == {"story", "doc"}


def test_parse_entity_embeds_deduplication():
    """같은 entity 중복 시 하나만 포함."""
    from app.routers.memos import _parse_entity_embeds
    content = (
        f"[첫 번째](entity:story:{STORY_ID}) "
        f"[두 번째](entity:story:{STORY_ID})"
    )
    embeds = _parse_entity_embeds(content)
    assert len(embeds) == 1


def test_parse_entity_embeds_no_match():
    """패턴 없는 content → 빈 리스트."""
    from app.routers.memos import _parse_entity_embeds
    embeds = _parse_entity_embeds("entity 링크 없는 일반 텍스트")
    assert embeds == []


def test_parse_entity_embeds_position_order():
    """position이 등장 순서 기반."""
    from app.routers.memos import _parse_entity_embeds
    content = (
        f"[스토리](entity:story:{STORY_ID}) "
        f"[문서](entity:doc:{DOC_ID})"
    )
    embeds = _parse_entity_embeds(content)
    story = next(e for e in embeds if e.entity_type == "story")
    doc = next(e for e in embeds if e.entity_type == "doc")
    assert story.position < doc.position


# ─── AC1: create_memo 시 embeds 자동 파싱 + 저장 ─────────────────────────────

@pytest.mark.anyio
async def test_create_memo_auto_parses_entity_embeds():
    """content 내 entity 링크 → embeds 자동 파싱 + create_entity_links 호출."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    ctx = MagicMock()
    ctx.user_id = str(MEMBER_ID)
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}
    mock_session = AsyncMock()
    mock_session.add = MagicMock()
    mock_session.flush = AsyncMock()
    mock_session.commit = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        mock_memo = MagicMock()
        mock_memo.id = MEMO_ID
        mock_memo.org_id = ORG_ID
        mock_memo.project_id = PROJECT_ID
        mock_memo.memo_type = "memo"
        mock_memo.title = "테스트"
        mock_memo.content = f"[스토리 참조](entity:story:{STORY_ID})"
        mock_memo.created_by = MEMBER_ID
        mock_memo.assigned_to = None
        mock_memo.status = "open"
        mock_memo.supersedes_id = None
        mock_memo.resolved_by = None
        mock_memo.resolved_at = None
        mock_memo.archived_at = None
        mock_memo.deleted_at = None
        mock_memo.memo_metadata = {}
        mock_memo.embed_count = 0
        mock_memo.reply_count = 0
        mock_memo.latest_reply_at = None
        mock_memo.created_at = datetime(2026, 5, 11, tzinfo=timezone.utc)
        mock_memo.updated_at = datetime(2026, 5, 11, tzinfo=timezone.utc)

        with patch("app.repositories.memo.MemoRepository.create", new_callable=AsyncMock) as mock_create, \
             patch("app.repositories.memo.MemoRepository.create_entity_links", new_callable=AsyncMock) as mock_links, \
             patch("app.routers.memos.publish_event"), \
             patch("app.services.workflow_pipeline.process_event", new_callable=AsyncMock):
            mock_create.return_value = mock_memo
            mock_session.execute = AsyncMock(return_value=MagicMock())

            from httpx import ASGITransport, AsyncClient
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                resp = await c.post("/api/v2/memos", json={
                    "org_id": str(ORG_ID),
                    "project_id": str(PROJECT_ID),
                    "content": f"[스토리 참조](entity:story:{STORY_ID})",
                    "memo_type": "memo",
                    "title": "테스트",
                    "created_by": str(MEMBER_ID),
                })

        assert resp.status_code == 201
        assert resp.json()["embed_count"] == 1
        mock_links.assert_called_once()
        call_embeds = mock_links.call_args[0][1]
        assert len(call_embeds) == 1
        assert str(call_embeds[0].entity_id) == str(STORY_ID)
    finally:
        app.dependency_overrides.clear()


# ─── AC2: embed_count == len(embeds) ─────────────────────────────────────────

@pytest.mark.anyio
async def test_create_memo_embed_count_matches_parsed():
    """두 entity 링크 파싱 시 embed_count=2."""
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    ctx = MagicMock()
    ctx.user_id = str(MEMBER_ID)
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}
    mock_session = AsyncMock()
    mock_session.add = MagicMock()
    mock_session.flush = AsyncMock()
    mock_session.commit = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    try:
        mock_memo = MagicMock()
        mock_memo.id = MEMO_ID
        mock_memo.org_id = ORG_ID
        mock_memo.project_id = PROJECT_ID
        mock_memo.memo_type = "memo"
        mock_memo.title = "테스트"
        mock_memo.content = f"[스토리](entity:story:{STORY_ID}) [문서](entity:doc:{DOC_ID})"
        mock_memo.created_by = MEMBER_ID
        mock_memo.assigned_to = None
        mock_memo.status = "open"
        mock_memo.supersedes_id = None
        mock_memo.resolved_by = None
        mock_memo.resolved_at = None
        mock_memo.archived_at = None
        mock_memo.deleted_at = None
        mock_memo.memo_metadata = {}
        mock_memo.embed_count = 0
        mock_memo.reply_count = 0
        mock_memo.latest_reply_at = None
        mock_memo.created_at = datetime(2026, 5, 11, tzinfo=timezone.utc)
        mock_memo.updated_at = datetime(2026, 5, 11, tzinfo=timezone.utc)

        with patch("app.repositories.memo.MemoRepository.create", new_callable=AsyncMock) as mock_create, \
             patch("app.repositories.memo.MemoRepository.create_entity_links", new_callable=AsyncMock), \
             patch("app.routers.memos.publish_event"), \
             patch("app.services.workflow_pipeline.process_event", new_callable=AsyncMock):
            mock_create.return_value = mock_memo
            mock_session.execute = AsyncMock(return_value=MagicMock())

            from httpx import ASGITransport, AsyncClient
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
                resp = await c.post("/api/v2/memos", json={
                    "org_id": str(ORG_ID),
                    "project_id": str(PROJECT_ID),
                    "content": f"[스토리](entity:story:{STORY_ID}) [문서](entity:doc:{DOC_ID})",
                    "memo_type": "memo",
                    "title": "테스트",
                    "created_by": str(MEMBER_ID),
                })

        assert resp.status_code == 201
        assert resp.json()["embed_count"] == 2
    finally:
        app.dependency_overrides.clear()
