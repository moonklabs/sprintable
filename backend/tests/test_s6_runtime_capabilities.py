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

    유나 라이브픽셀 발견(2026-07-08, 승격 前 fix): ``prompt_file``은 kit 파일명(KIT_FILENAME=
    SPRINTABLE_ONBOARDING.md, `agents.py`의 다운로드 아티팩트 — 그건 계속 런타임 무관 단일)이
    **아니다** — 그 런타임 자신의 기존 정체성 지침 파일명이다(FE STEP4 전달노트 "기존 X 그대로"
    문구용). #1967/#1974가 이 둘을 conflate해 전 런타임에 SPRINTABLE_ONBOARDING.md를 반환하는
    자기모순("기존 SPRINTABLE_ONBOARDING.md 그대로" — 방금 새로 놓이는 파일인데 "기존"이라니)
    버그를 냈다. apps/web/src/services/recruit.ts::RUNTIME_CAPABILITIES_FALLBACK과 값 동기화."""
    from app.services.agent_onboarding_config import list_runtime_capabilities

    caps = {c["slug"]: c for c in list_runtime_capabilities()}
    assert caps["claude-code"]["tier"] == "full"
    assert caps["gemini"]["tier"] == "full"
    for slug in ("codex", "cursor", "grok", "pi", "hermes", "openclaw", "opencode"):
        assert caps[slug]["tier"] == "full", slug
    assert caps["connector"]["tier"] == "experimental"
    assert caps["claude-code"]["prompt_file"] == "CLAUDE.md"
    assert caps["codex"]["prompt_file"] == "AGENTS.md"
    assert caps["gemini"]["prompt_file"] == "GEMINI.md"
    assert caps["connector"]["prompt_file"] == "AGENT_INSTRUCTIONS.md"
    for slug in ("cursor", "grok", "pi", "hermes", "openclaw", "opencode"):
        assert caps[slug]["prompt_file"] == "AGENTS.md", slug
    for slug in caps:
        assert caps[slug]["prompt_file"] != "SPRINTABLE_ONBOARDING.md", (
            f"{slug}: prompt_file must never equal the kit write-target filename"
        )

    for slug in ("claude-code", "codex", "gemini", "cursor"):
        assert caps[slug]["supports_event_push"] is True
        assert set(caps[slug]["mcp_transport"]) == {"stdio", "http"}
    for slug in ("connector", "opencode", "openclaw", "grok", "pi"):
        assert caps[slug]["mcp_transport"] == [], slug
        assert caps[slug]["supports_event_push"] is False, slug
        assert caps[slug]["transport"] is None, slug
        assert caps[slug]["guide_filename"] == "CONNECTOR_SETUP.md", slug

    # story #2466(P1-B) + 유나 정렬 v1.3(spec-2377 §1.5): hermes는 ①(도구전달)=[라이브] 실증
    # (자체 CLI로 http MCP 110개 도구 라이브 왕복)돼 HTTP_MCP_CAPABLE_RUNTIMES에 편입 — transport/
    # mcp_transport는 채워지지만, ②(깨우기)는 미측정으로 남아 guide_filename은 그대로 유지된다
    # (두 축이 hermes에서 동시에 참 — 나머지 커넥터-전용 그룹과 분리해서 검증).
    assert set(caps["hermes"]["mcp_transport"]) == {"stdio", "http"}
    assert caps["hermes"]["transport"] in ("stdio", "http")
    assert caps["hermes"]["supports_event_push"] is False
    assert caps["hermes"]["guide_filename"] == "CONNECTOR_SETUP.md"
    # openclaw는 config-shape만 검증(PO 결정 2026-08-05, §1.5) — 완전 왕복 미확認이라 재분류 안 됨.
    assert caps["openclaw"]["transport"] is None
    assert caps["openclaw"]["mcp_transport"] == []


def test_no_unsupported_runtimes_left_coming_soon_section_empty():
    """전 런타임 올지원(story 6f6ac081) 목표 — RuntimeType 9종(+connector) 전부 supported=true.
    '곧 지원' 섹션은 이제 비어야 한다(vaporware 0)."""
    from app.services.agent_onboarding_config import list_runtime_capabilities

    caps = list_runtime_capabilities()
    assert all(c["supported"] for c in caps)
    assert all(c["tier"] is not None for c in caps)
