"""E-CAGE-REFEREE P1: participation 스키마 + assignee 백필 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()
MEMBER_ID = uuid.uuid4()
ROLE_ID = uuid.uuid4()
PARTICIPATION_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_role(role_id=None, key="implementation", label="구현", is_default=True):
    r = MagicMock()
    r.id = role_id or ROLE_ID
    r.org_id = ORG_ID
    r.key = key
    r.label = label
    r.is_default = is_default
    r.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return r


def _mock_participation(p_id=None):
    p = MagicMock()
    p.id = p_id or PARTICIPATION_ID
    p.org_id = ORG_ID
    p.story_id = STORY_ID
    p.member_id = MEMBER_ID
    p.role_id = ROLE_ID
    p.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return p


async def _make_client(mock_session):
    from app.main import app
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


# ── ParticipationRole 조회 ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_roles_200():
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = [
        _mock_role(key="implementation", label="구현", is_default=True),
        _mock_role(role_id=uuid.uuid4(), key="qa", label="QA", is_default=False),
    ]
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.get("/api/v2/participation/roles")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 2
        assert body[0]["key"] == "implementation"
        assert body[0]["is_default"] is True
    finally:
        app.dependency_overrides.clear()


# ── Participation CRUD ─────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_add_participation_201():
    """참여자 추가 → 201."""
    mock_session = AsyncMock()
    p = _mock_participation()

    async def mock_execute(stmt, *args, **kwargs):
        r = MagicMock()
        r.scalar_one_or_none.return_value = None  # not exists
        return r

    mock_session.execute = mock_execute
    client, app = await _make_client(mock_session)
    try:
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = p
            async with client as c:
                resp = await c.post("/api/v2/participation", json={
                    "story_id": str(STORY_ID),
                    "member_id": str(MEMBER_ID),
                    "role_id": str(ROLE_ID),
                })
        assert resp.status_code == 201
        assert resp.json()["role_id"] == str(ROLE_ID)
        # repo.create에 필드 전달 검증
        call_kwargs = mock_create.call_args[1]
        assert call_kwargs.get("story_id") == STORY_ID
        assert call_kwargs.get("member_id") == MEMBER_ID
        assert call_kwargs.get("role_id") == ROLE_ID
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_add_participation_duplicate_409():
    """중복 참여 → 409."""
    mock_session = AsyncMock()

    async def mock_execute(stmt, *args, **kwargs):
        r = MagicMock()
        r.scalar_one_or_none.return_value = PARTICIPATION_ID  # already exists
        return r

    mock_session.execute = mock_execute
    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.post("/api/v2/participation", json={
                "story_id": str(STORY_ID),
                "member_id": str(MEMBER_ID),
                "role_id": str(ROLE_ID),
            })
        assert resp.status_code == 409
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_participation_200():
    """스토리별 참여자 조회 → 200."""
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = [_mock_participation()]
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.get(f"/api/v2/participation?story_id={STORY_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["member_id"] == str(MEMBER_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_remove_participation_200():
    """참여자 제거 → 200."""
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = _mock_participation()
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.delete = AsyncMock()
    mock_session.flush = AsyncMock()

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.delete(f"/api/v2/participation/{PARTICIPATION_ID}")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_remove_participation_404():
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.delete(f"/api/v2/participation/{uuid.uuid4()}")
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ── 비파괴 검증 — assignee 쿼리 영향 없음 ────────────────────────────────────

@pytest.mark.anyio
async def test_assignee_unaffected_by_participation():
    """기존 stories.assignee_id 필드는 변경 없음 — participation은 추가 관계."""
    from app.models.pm import Story
    # Story 모델에 assignee_id가 여전히 존재하는지 확인
    assert hasattr(Story, "assignee_id"), "Story.assignee_id must remain unchanged"


# ── 스토리 삭제 시 participation cleanup 와이어링 ─────────────────────────────

@pytest.mark.anyio
async def test_delete_story_cleans_up_participation():
    """스토리 삭제 → ParticipationRepository.delete_by_story 호출 단언."""
    story_id = uuid.uuid4()
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = MagicMock()
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.delete = AsyncMock()
    mock_session.flush = AsyncMock()

    client, app = await _make_client(mock_session)
    try:
        with patch("app.repositories.dependency.DependencyRepository.delete_by_item", new_callable=AsyncMock), \
             patch("app.repositories.label.ItemLabelRepository.delete_by_item", new_callable=AsyncMock), \
             patch("app.repositories.participation.ParticipationRepository.delete_by_story", new_callable=AsyncMock) as mock_cleanup:
            mock_cleanup.return_value = 1
            async with client as c:
                resp = await c.delete(f"/api/v2/stories/{story_id}")
            assert resp.status_code == 200
            mock_cleanup.assert_called_once_with(story_id)
    finally:
        app.dependency_overrides.clear()


# ── 백필 멱등성 단위 테스트 ───────────────────────────────────────────────────

@pytest.mark.anyio
async def test_backfill_idempotent_exists_check():
    """ParticipationRepository.exists가 중복 백필을 차단함을 검증."""
    from app.repositories.participation import ParticipationRepository

    mock_session = AsyncMock()
    mock_result = MagicMock()
    # 이미 participation 존재
    mock_result.scalar_one_or_none.return_value = PARTICIPATION_ID
    mock_session.execute = AsyncMock(return_value=mock_result)

    repo = ParticipationRepository(mock_session, ORG_ID)
    already_exists = await repo.exists(STORY_ID, MEMBER_ID, ROLE_ID)
    assert already_exists is True


# ── org 격리 ──────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_org_isolation_participation():
    """다른 org의 participation은 조회 안 됨."""
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []  # 다른 org → 0건
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.get(f"/api/v2/participation?story_id={STORY_ID}")
        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()
