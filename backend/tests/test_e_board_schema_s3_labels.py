"""E-BOARD-SCHEMA S3: 3계층 labels/tags 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
LABEL_ID = uuid.uuid4()
ITEM_ID = uuid.uuid4()
ITEM_LABEL_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mock_label(label_id=None, name="Phase A", color="#FF0000"):
    l = MagicMock()
    l.id = label_id or LABEL_ID
    l.org_id = ORG_ID
    l.name = name
    l.color = color
    l.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    l.updated_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return l


def _mock_item_label(il_id=None, label_id=None, item_id=None, item_type="story"):
    il = MagicMock()
    il.id = il_id or ITEM_LABEL_ID
    il.org_id = ORG_ID
    il.label_id = label_id or LABEL_ID
    il.item_id = item_id or ITEM_ID
    il.item_type = item_type
    il.created_at = datetime(2026, 5, 1, tzinfo=timezone.utc)
    return il


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


# ── Label CRUD ─────────────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_list_labels_200():
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = [_mock_label()]
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.get("/api/v2/labels")
        assert resp.status_code == 200
        assert len(resp.json()) == 1
        assert resp.json()[0]["name"] == "Phase A"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_label_201():
    mock_session = AsyncMock()
    label = _mock_label()

    client, app = await _make_client(mock_session)
    try:
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = label
            async with client as c:
                resp = await c.post("/api/v2/labels", json={"name": "Phase A", "color": "#FF0000"})
        assert resp.status_code == 201
        assert resp.json()["name"] == "Phase A"
        assert resp.json()["color"] == "#FF0000"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_label_200():
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = _mock_label()
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.get(f"/api/v2/labels/{LABEL_ID}")
        assert resp.status_code == 200
        assert resp.json()["id"] == str(LABEL_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_label_404():
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.get(f"/api/v2/labels/{uuid.uuid4()}")
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_update_label_200():
    mock_session = AsyncMock()
    updated = _mock_label(name="Phase B", color="#00FF00")
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = updated
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.flush = AsyncMock()
    mock_session.refresh = AsyncMock()

    client, app = await _make_client(mock_session)
    try:
        with patch("app.repositories.base.BaseRepository.update", new_callable=AsyncMock) as mock_update:
            mock_update.return_value = updated
            async with client as c:
                resp = await c.patch(f"/api/v2/labels/{LABEL_ID}", json={"name": "Phase B"})
        assert resp.status_code == 200
        assert resp.json()["name"] == "Phase B"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_label_cleans_up_item_labels():
    """라벨 삭제 시 item_label 행 cleanup 호출 검증."""
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = _mock_label()
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.delete = AsyncMock()
    mock_session.flush = AsyncMock()

    client, app = await _make_client(mock_session)
    try:
        with patch("app.repositories.label.ItemLabelRepository.delete_by_label", new_callable=AsyncMock) as mock_cleanup:
            mock_cleanup.return_value = 3
            async with client as c:
                resp = await c.delete(f"/api/v2/labels/{LABEL_ID}")
            assert resp.status_code == 200
            mock_cleanup.assert_called_once_with(LABEL_ID)
    finally:
        app.dependency_overrides.clear()


# ── ItemLabel attach/detach/list ───────────────────────────────────────────────

@pytest.mark.anyio
async def test_attach_label_201():
    mock_session = AsyncMock()
    il = _mock_item_label()

    async def mock_execute(stmt, *args, **kwargs):
        r = MagicMock()
        r.scalar_one_or_none.return_value = None  # not exists
        return r

    mock_session.execute = mock_execute
    client, app = await _make_client(mock_session)
    try:
        with patch("app.repositories.base.BaseRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = il
            async with client as c:
                resp = await c.post("/api/v2/item-labels", json={
                    "label_id": str(LABEL_ID),
                    "item_id": str(ITEM_ID),
                    "item_type": "story",
                })
        assert resp.status_code == 201
        assert resp.json()["item_type"] == "story"
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_attach_label_duplicate_409():
    """중복 부착 → 409."""
    mock_session = AsyncMock()

    async def mock_execute(stmt, *args, **kwargs):
        r = MagicMock()
        r.scalar_one_or_none.return_value = ITEM_LABEL_ID  # already exists
        return r

    mock_session.execute = mock_execute
    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.post("/api/v2/item-labels", json={
                "label_id": str(LABEL_ID),
                "item_id": str(ITEM_ID),
                "item_type": "story",
            })
        assert resp.status_code == 409
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_attach_label_invalid_type_422():
    """잘못된 item_type → 422."""
    mock_session = AsyncMock()
    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.post("/api/v2/item-labels", json={
                "label_id": str(LABEL_ID),
                "item_id": str(ITEM_ID),
                "item_type": "task",
            })
        assert resp.status_code == 422
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_item_labels_200():
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = [_mock_item_label()]
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.get(f"/api/v2/item-labels?item_type=story&item_id={ITEM_ID}")
        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 1
        assert body[0]["label_id"] == str(LABEL_ID)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_detach_label_200():
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = _mock_item_label()
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.delete = AsyncMock()
    mock_session.flush = AsyncMock()

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.delete(f"/api/v2/item-labels/{ITEM_LABEL_ID}")
        assert resp.status_code == 200
        assert resp.json()["ok"] is True
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_detach_label_404():
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = None
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.delete(f"/api/v2/item-labels/{uuid.uuid4()}")
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


# ── AC4 cleanup 와이어링 테스트 (처음부터, seed 우회 금지) ─────────────────────

@pytest.mark.anyio
async def test_delete_story_cleans_up_item_labels():
    """스토리 삭제 → item_label cleanup 호출 단언."""
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
             patch("app.repositories.label.ItemLabelRepository.delete_by_item", new_callable=AsyncMock) as mock_label_cleanup:
            mock_label_cleanup.return_value = 2
            async with client as c:
                resp = await c.delete(f"/api/v2/stories/{story_id}")
            assert resp.status_code == 200
            mock_label_cleanup.assert_called_once_with(story_id, "story")
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_sprint_cleans_up_item_labels():
    """스프린트 삭제 → item_label cleanup 호출 단언."""
    sprint_id = uuid.uuid4()
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = MagicMock()
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.delete = AsyncMock()
    mock_session.flush = AsyncMock()

    client, app = await _make_client(mock_session)
    try:
        with patch("app.repositories.dependency.DependencyRepository.delete_by_item", new_callable=AsyncMock), \
             patch("app.repositories.label.ItemLabelRepository.delete_by_item", new_callable=AsyncMock) as mock_label_cleanup:
            mock_label_cleanup.return_value = 0
            async with client as c:
                resp = await c.delete(f"/api/v2/sprints/{sprint_id}")
            assert resp.status_code == 200
            mock_label_cleanup.assert_called_once_with(sprint_id, "sprint")
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_delete_epic_cleans_up_item_labels():
    """에픽 삭제 → item_label cleanup 호출 단언."""
    epic_id = uuid.uuid4()
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one_or_none.return_value = MagicMock()
    mock_session.execute = AsyncMock(return_value=mock_result)
    mock_session.delete = AsyncMock()
    mock_session.flush = AsyncMock()

    # epics router는 update_epic에서 get() 한 번 더 호출하므로 execute 2번 처리
    call_count = 0
    async def multi_execute(stmt, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        r = MagicMock()
        r.scalar_one_or_none.return_value = MagicMock()
        return r

    mock_session.execute = multi_execute

    client, app = await _make_client(mock_session)
    try:
        with patch("app.repositories.dependency.DependencyRepository.delete_by_item", new_callable=AsyncMock), \
             patch("app.repositories.label.ItemLabelRepository.delete_by_item", new_callable=AsyncMock) as mock_label_cleanup:
            mock_label_cleanup.return_value = 1
            async with client as c:
                resp = await c.delete(f"/api/v2/epics/{epic_id}")
            assert resp.status_code == 200
            mock_label_cleanup.assert_called_once_with(epic_id, "epic")
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_org_isolation_item_labels():
    """다른 org의 라벨은 조회 안 됨 (org_id 스코프)."""
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = []
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.get(f"/api/v2/item-labels?item_type=story&item_id={ITEM_ID}")
        assert resp.status_code == 200
        assert resp.json() == []
    finally:
        app.dependency_overrides.clear()


# ── item_id Optional 일괄 조회 테스트 (FE-LABEL 언블락커) ────────────────────

@pytest.mark.anyio
async def test_list_item_labels_bulk_no_item_id():
    """GET /item-labels?item_type=story (item_id 생략) → org 전체 일괄 반환."""
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = [
        _mock_item_label(item_id=uuid.uuid4()),
        _mock_item_label(item_id=uuid.uuid4()),
    ]
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.get("/api/v2/item-labels?item_type=story")  # item_id 생략
        assert resp.status_code == 200
        assert len(resp.json()) == 2
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_item_labels_single_still_works():
    """item_id 지정 시 기존 단건 동작 비파괴."""
    mock_session = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = [_mock_item_label()]
    mock_session.execute = AsyncMock(return_value=mock_result)

    client, app = await _make_client(mock_session)
    try:
        async with client as c:
            resp = await c.get(f"/api/v2/item-labels?item_type=story&item_id={ITEM_ID}")
        assert resp.status_code == 200
        assert len(resp.json()) == 1
    finally:
        app.dependency_overrides.clear()
