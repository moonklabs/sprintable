"""SS-1: auth context 강제 — AC6/AC7 mismatch 403 테스트."""
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
OTHER_ORG_ID = uuid.uuid4()
OTHER_PROJECT_ID = uuid.uuid4()


def _mk_ctx(org_id: uuid.UUID = ORG_ID, project_id: uuid.UUID = PROJECT_ID) -> MagicMock:
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(org_id), "project_id": str(project_id)}}
    ctx.org_id = str(org_id)
    return ctx


async def _client(ctx: MagicMock):
    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db
    from app.main import app

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), app


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── AC6: body.org_id ≠ auth.org_id → 403 ────────────────────────────────────

@pytest.mark.anyio
async def test_create_doc_org_id_mismatch_403():
    """AC6: docs POST — body.org_id ≠ auth.org_id → 403."""
    ctx = _mk_ctx(org_id=ORG_ID)
    client, app = await _client(ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/docs", json={
                "project_id": str(PROJECT_ID),
                "org_id": str(OTHER_ORG_ID),
                "title": "악의적 doc",
                "slug": "evil-doc",
            })
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_story_org_id_mismatch_403():
    """AC6: stories POST — body.org_id ≠ auth.org_id → 403."""
    ctx = _mk_ctx(org_id=ORG_ID)
    client, app = await _client(ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/stories", json={
                "project_id": str(PROJECT_ID),
                "org_id": str(OTHER_ORG_ID),
                "title": "악의적 스토리",
            })
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_epic_org_id_mismatch_403():
    """AC6: epics POST — body.org_id ≠ auth.org_id → 403."""
    ctx = _mk_ctx(org_id=ORG_ID)
    client, app = await _client(ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/epics", json={
                "project_id": str(PROJECT_ID),
                "org_id": str(OTHER_ORG_ID),
                "title": "악의적 에픽",
            })
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.xfail(reason="E-MEMO-RETIRE S3-3: /api/v2/memos 라우터 제거됨 — 404 반환", strict=False)
@pytest.mark.anyio
async def test_create_memo_org_id_mismatch_403():
    """AC6: memos POST — body.org_id ≠ auth.org_id → 403."""
    ctx = _mk_ctx(org_id=ORG_ID)
    client, app = await _client(ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/memos", json={
                "project_id": str(PROJECT_ID),
                "org_id": str(OTHER_ORG_ID),
                "title": "악의적 메모",
                "content": "test",
            })
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


# ─── AC7: body.project_id ≠ auth.project_id → 403 ───────────────────────────

@pytest.mark.anyio
async def test_create_doc_project_id_mismatch_403():
    """AC7: docs POST — body.project_id ≠ auth.project_id → 403."""
    ctx = _mk_ctx(project_id=PROJECT_ID)
    client, app = await _client(ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/docs", json={
                "project_id": str(OTHER_PROJECT_ID),
                "org_id": str(ORG_ID),
                "title": "교차 프로젝트 doc",
                "slug": "cross-project-doc",
            })
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_meeting_project_id_mismatch_403():
    """AC7: meetings POST — body.project_id ≠ auth.project_id → 403."""
    ctx = _mk_ctx(project_id=PROJECT_ID)
    client, app = await _client(ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/meetings", json={
                "project_id": str(OTHER_PROJECT_ID),
                "title": "교차 프로젝트 미팅",
                "meeting_type": "general",
            })
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()
