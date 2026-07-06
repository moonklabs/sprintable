"""S6(유나/미르코 정합용): GET /api/v2/runtime-capabilities 계약 테스트.

supported/tier는 app.services.agent_onboarding_config.list_runtime_capabilities SSOT 기준
(S5 emit 코드 실기준 — 과대약속 금지). 이 테스트는 계약 shape + 판정 근거 정합만 검증한다.
"""
import uuid

import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_runtime_capabilities_200_and_shape():
    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app

    ctx = AuthContext(user_id=str(uuid.uuid4()), email=None, claims={"app_metadata": {}})
    app.dependency_overrides[get_current_user] = lambda: ctx
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            resp = await c.get("/api/v2/runtime-capabilities")
        assert resp.status_code == 200
        data = resp.json()
        slugs = {r["slug"] for r in data}
        assert slugs == {"claude-code", "codex", "gemini", "cursor", "connector"}
        for r in data:
            assert r["supported"] is True
            assert r["tier"] in ("full", "experimental")
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_runtime_capabilities_401_when_unauthenticated():
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.get("/api/v2/runtime-capabilities")
    assert resp.status_code in (401, 403)


def test_claude_code_is_full_tier_others_experimental():
    """S5 emit 실기준: instruction filename 확정 매핑(CLAUDE.md)이 있는 claude-code만 tier=full —
    나머지 MCP-native(codex/gemini/cursor)는 S7 shaping 전 generic fallback이라 experimental.
    connector는 실 어댑터 조립이 후속이라 experimental."""
    from app.services.agent_onboarding_config import list_runtime_capabilities

    caps = {c["slug"]: c for c in list_runtime_capabilities()}
    assert caps["claude-code"]["tier"] == "full"
    assert caps["claude-code"]["prompt_file"] == "CLAUDE.md"
    for slug in ("codex", "gemini", "cursor", "connector"):
        assert caps[slug]["tier"] == "experimental"
    assert caps["connector"]["mcp_transport"] == []
    assert caps["connector"]["supports_event_push"] is False
    assert caps["connector"]["guide_filename"] == "CONNECTOR_SETUP.md"
    for slug in ("claude-code", "codex", "gemini", "cursor"):
        assert caps[slug]["supports_event_push"] is True
        assert set(caps[slug]["mcp_transport"]) == {"stdio", "http"}
