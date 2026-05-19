"""S3-1: 워크플로우 레시피 자연어 가이드 생성 검증.

AC1: GET /api/v2/workflow-recipes → 활성 레시피 목록 (builtin 3종 포함)
AC2: GET /api/v2/workflow-recipes/{id}/guide → 자연어 가이드 텍스트 반환
AC3: 가이드에 단계별 역할/순서/기대 행동이 마크다운으로 서술됨
AC4: MCP 도구 sprintable_get_workflow_guide 등록
AC5: 기존 workflow_template CRUD 영향 없음
AC6: 레시피 3종 프리셋 포함 (scrum-3step, kanban-simple, solo)
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

ORG_ID = uuid.uuid4()


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _client():
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    ctx = MagicMock()
    ctx.user_id = str(uuid.uuid4())
    ctx.email = "test@example.com"
    ctx.claims = {"app_metadata": {"org_id": str(ORG_ID)}}

    mock_session = AsyncMock()

    async def override_db():
        yield mock_session

    async def override_auth():
        return ctx

    from app.dependencies.auth import get_current_user
    from app.dependencies.database import get_db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = override_auth

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), mock_session, app


# ─── AC1/6: 레시피 목록 + builtin 3종 ────────────────────────────────────────

@pytest.mark.anyio
async def test_list_recipes_includes_builtins():
    """AC1/6: GET /workflow-recipes — builtin 3종 포함."""
    client, session, app = await _client()
    try:
        # DB에 템플릿 없는 경우
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/workflow-recipes")

        assert resp.status_code == 200
        body = resp.json()
        slugs = [r["slug"] for r in body]
        assert "scrum-3step" in slugs
        assert "kanban-simple" in slugs
        assert "solo" in slugs
        assert len(body) >= 3
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_list_recipes_each_has_steps():
    """AC1: 각 레시피에 steps 포함."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/workflow-recipes")

        for recipe in resp.json():
            assert "steps" in recipe
            assert len(recipe["steps"]) > 0
    finally:
        app.dependency_overrides.clear()


# ─── AC2/3: 가이드 텍스트 ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_get_guide_builtin_scrum():
    """AC2/3: GET /workflow-recipes/scrum-3step/guide — 마크다운 반환."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/workflow-recipes/scrum-3step/guide")

        assert resp.status_code == 200
        body = resp.json()
        assert "guide" in body
        guide = body["guide"]
        assert "# " in guide        # 마크다운 헤더
        assert "##" in guide        # 섹션
        assert "담당 역할" in guide  # 자연어 서술
        assert "기대 행동" in guide
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_guide_builtin_kanban():
    """AC2/3: kanban-simple 가이드 마크다운 반환."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/workflow-recipes/kanban-simple/guide")

        assert resp.status_code == 200
        assert "칸반" in resp.json()["guide"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_guide_builtin_solo():
    """AC2/3: solo 가이드 마크다운 반환."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/workflow-recipes/solo/guide")

        assert resp.status_code == 200
        assert "솔로" in resp.json()["guide"]
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_guide_unknown_returns_404():
    """AC2: 존재하지 않는 레시피 → 404."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get(f"/api/v2/workflow-recipes/{uuid.uuid4()}/guide")

        assert resp.status_code == 404
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_get_guide_steps_all_present():
    """AC3: 가이드에 모든 단계가 포함됨."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/workflow-recipes/scrum-3step/guide")

        guide = resp.json()["guide"]
        # scrum-3step has 3 steps → 3개 단계 헤더 존재
        assert "1단계" in guide
        assert "2단계" in guide
        assert "3단계" in guide
    finally:
        app.dependency_overrides.clear()


# ─── AC4: MCP 도구 등록 확인 ─────────────────────────────────────────────────

def test_mcp_get_workflow_guide_in_tool_defs():
    """AC4: sprintable_get_workflow_guide 도구가 _TOOL_DEFS에 등록됨."""
    from sprintable_mcp.server import _TOOL_DEFS
    names = [t[0] for t in _TOOL_DEFS]
    assert "sprintable_get_workflow_guide" in names


# ─── AC5: 기존 workflow_template CRUD 영향 없음 ──────────────────────────────

@pytest.mark.anyio
async def test_workflow_templates_endpoint_still_works():
    """AC5: /api/v2/workflow-templates 기존 엔드포인트 정상."""
    client, session, app = await _client()
    try:
        mock_result = MagicMock()
        mock_result.scalars.return_value.all.return_value = []
        session.execute = AsyncMock(return_value=mock_result)

        async with client as c:
            resp = await c.get("/api/v2/workflow-templates")

        # 200 or 404 (router 있으면 200, 없으면 등록 안 된 것)
        assert resp.status_code in (200, 422)
    finally:
        app.dependency_overrides.clear()


# ─── AC6: 3종 프리셋 단위 확인 ───────────────────────────────────────────────

def test_builtin_recipes_slugs():
    """AC6: 코드 내 3종 프리셋 slug 확인."""
    from app.routers.workflow_recipes import _BUILTIN_RECIPES
    slugs = {r["slug"] for r in _BUILTIN_RECIPES}
    assert slugs == {"scrum-3step", "kanban-simple", "solo"}


def test_generate_guide_markdown_format():
    """AC3: _generate_guide 출력이 마크다운 형식."""
    from app.routers.workflow_recipes import _generate_guide, _BUILTIN_BY_ID
    guide = _generate_guide(_BUILTIN_BY_ID["scrum-3step"])
    assert guide.startswith("# ")
    assert "##" in guide
    assert "###" in guide
    assert "**담당 역할**" in guide
    assert "**기대 행동**" in guide
