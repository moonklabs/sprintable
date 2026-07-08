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
        assert slugs == {
            "claude-code", "codex", "gemini", "cursor", "connector",
            "opencode", "openclaw", "hermes", "grok", "pi",
        }
        # 전 런타임 올지원(story 6f6ac081) — RuntimeType 9종 전부 supported=true(connector 포함
        # 10 전부). "곧 지원" 섹션은 비게 된다(의도된 결과).
        supported = {r["slug"] for r in data if r["supported"]}
        assert supported == slugs
        for r in data:
            assert r["tier"] in ("full", "experimental")
    finally:
        app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_runtime_capabilities_401_when_unauthenticated():
    from app.main import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.get("/api/v2/runtime-capabilities")
    assert resp.status_code in (401, 403)


def test_instruction_filename_tiers_and_transport_by_runtime_class():
    """전 런타임 올지원(story 6f6ac081, 문서 `runtime-full-support-firstclass-crux`) 후 실기준:
    구체적으로 이름 붙은 8종(claude-code·gemini·codex/cursor/grok/pi/hermes/openclaw/opencode)은
    tier=full — 범용 connector 버킷(특정 런타임 미확정)만 tier=experimental로 남는다. MCP-native
    4종만 mcp_transport 보유·event_push 지원 — 커넥터 전용 5종+connector는 SSE 경로라 전부 빈값.

    채용-kit 재설계(story b1fe41cf, 선생님 GO 2026-07-08): ``prompt_file``은 이제 런타임 무관
    단일 파일명(``KIT_FILENAME`` = ``SPRINTABLE_ONBOARDING.md``) — 예전엔 CLAUDE.md/GEMINI.md/
    AGENTS.md로 런타임별로 갈렸는데, 그 리터럴이 유저의 실제 정체성 파일을 덮어쓰는 버그의
    원인이라 통일했다."""
    from app.services.agent_onboarding_config import KIT_FILENAME, list_runtime_capabilities

    caps = {c["slug"]: c for c in list_runtime_capabilities()}
    assert caps["claude-code"]["tier"] == "full"
    assert caps["gemini"]["tier"] == "full"
    for slug in ("codex", "cursor", "grok", "pi", "hermes", "openclaw", "opencode"):
        assert caps[slug]["tier"] == "full", slug
    assert caps["connector"]["tier"] == "experimental"
    for slug in caps:
        assert caps[slug]["prompt_file"] == KIT_FILENAME, slug

    for slug in ("claude-code", "codex", "gemini", "cursor"):
        assert caps[slug]["supports_event_push"] is True
        assert set(caps[slug]["mcp_transport"]) == {"stdio", "http"}
    for slug in ("connector", "opencode", "openclaw", "hermes", "grok", "pi"):
        assert caps[slug]["mcp_transport"] == [], slug
        assert caps[slug]["supports_event_push"] is False, slug
        assert caps[slug]["transport"] is None, slug
        assert caps[slug]["guide_filename"] == "CONNECTOR_SETUP.md", slug


def test_no_unsupported_runtimes_left_coming_soon_section_empty():
    """전 런타임 올지원(story 6f6ac081) 목표 — RuntimeType 9종(+connector) 전부 supported=true.
    '곧 지원' 섹션은 이제 비어야 한다(vaporware 0)."""
    from app.services.agent_onboarding_config import list_runtime_capabilities

    caps = list_runtime_capabilities()
    assert all(c["supported"] for c in caps)
    assert all(c["tier"] is not None for c in caps)
