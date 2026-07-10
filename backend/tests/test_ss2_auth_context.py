"""SS-2: PUT/PATCH 엔드포인트 auth context 강제 — AC6 mismatch 403 + 정상 동작 테스트."""
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

ORG_ID = uuid.uuid4()
PROJECT_ID = uuid.uuid4()
OTHER_ORG_ID = uuid.uuid4()
TASK_ID = uuid.uuid4()
STORY_ID = uuid.uuid4()


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

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── AC1: create_task POST auth context 강제 (SS-1 누락분) ────────────────────

@pytest.mark.anyio
async def test_create_task_org_id_mismatch_403():
    """create_task: body.org_id ≠ auth.org_id → 403."""
    ctx = _mk_ctx(org_id=ORG_ID)
    client, session, app = await _client(ctx)
    try:
        async with client as c:
            resp = await c.post("/api/v2/tasks", json={
                "story_id": str(STORY_ID),
                "org_id": str(OTHER_ORG_ID),
                "title": "악의적 태스크",
            })
        assert resp.status_code == 403
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_create_task_correct_context_201():
    """create_task: auth.org_id 일치 시 201."""
    ctx = _mk_ctx(org_id=ORG_ID)
    client, session, app = await _client(ctx)
    try:
        mock_task = MagicMock()
        mock_task.id = uuid.uuid4()
        mock_task.story_id = STORY_ID
        mock_task.org_id = ORG_ID
        mock_task.title = "정상 태스크"
        mock_task.assignee_id = None
        mock_task.status = "todo"
        mock_task.story_points = None
        mock_task.deleted_at = None
        mock_task.created_at = datetime(2026, 5, 18, tzinfo=timezone.utc)
        mock_task.updated_at = datetime(2026, 5, 18, tzinfo=timezone.utc)

        from unittest.mock import patch
        with patch("app.repositories.task.TaskRepository.create", new_callable=AsyncMock) as mock_create:
            mock_create.return_value = mock_task
            async with client as c:
                resp = await c.post("/api/v2/tasks", json={
                    "story_id": str(STORY_ID),
                    "org_id": str(ORG_ID),
                    "title": "정상 태스크",
                })
        assert resp.status_code == 201
    finally:
        app.dependency_overrides.clear()


# ─── AC4: meetings PATCH/PUT _get_repo org 검증 ───────────────────────────────

@pytest.mark.anyio
async def test_patch_meeting_no_org_header_400():
    """meetings PATCH: org_id 없는 context → get_verified_org_id 400."""
    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {}
    ctx.org_id = None

    client, session, app = await _client(ctx)
    try:
        async with client as c:
            resp = await c.patch(
                f"/api/v2/meetings/{uuid.uuid4()}?project_id={PROJECT_ID}",
                json={"title": "수정"},
            )
        assert resp.status_code == 400
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_patch_meeting_with_org_context_passes_auth():
    """meetings PATCH: 올바른 org context → 인증 통과 후 404(리소스 없음)."""
    ctx = _mk_ctx(org_id=ORG_ID)
    client, session, app = await _client(ctx)
    try:
        # E-SECURITY SEC-S8(G): _get_repo가 이제 먼저 has_project_access를 조회한다 —
        # 1st call=access granted(truthy), 2nd call(repo.update 내부 get)=None(not found).
        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            r = MagicMock()
            r.scalar_one_or_none.return_value = 1 if call_count == 1 else None
            return r

        session.execute = mock_execute

        async with client as c:
            resp = await c.patch(
                f"/api/v2/meetings/{uuid.uuid4()}?project_id={PROJECT_ID}",
                json={"title": "수정"},
            )
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_put_meeting_with_org_context_passes_auth():
    """meetings PUT: 올바른 org context → 인증 통과 후 404(리소스 없음)."""
    ctx = _mk_ctx(org_id=ORG_ID)
    client, session, app = await _client(ctx)
    try:
        # E-SECURITY SEC-S8(G): _get_repo가 이제 먼저 has_project_access를 조회한다 —
        # 1st call=access granted(truthy), 2nd call(repo.update 내부 get)=None(not found).
        call_count = 0

        async def mock_execute(stmt, *a, **kw):
            nonlocal call_count
            call_count += 1
            r = MagicMock()
            r.scalar_one_or_none.return_value = 1 if call_count == 1 else None
            return r

        session.execute = mock_execute

        async with client as c:
            resp = await c.put(
                f"/api/v2/meetings/{uuid.uuid4()}?project_id={PROJECT_ID}",
                json={"title": "수정"},
            )
        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()
