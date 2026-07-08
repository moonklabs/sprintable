"""OB-1: agent_onboarding_config SSOT generator 가드 (블루프린트 §2/§7).

AC1: stdio .mcp.json(type=stdio·uvx·sprintable-mcp·env{SPRINTABLE_API_URL=backend-direct,
AGENT_API_KEY})·AGENT_ID/WS_URL/port 미포함. backend-direct URL=env(FASTAPI_URL)·CF 금지·local fallback.

E-RECRUIT d306eb82(OB-PUBLISH f5e1742d 후속): `sprintable` 0.1.0 PyPI 게시 완료로 bare
`uvx sprintable` 원복(과거 S21의 git+subdirectory 우회는 걷어냄). 콘솔 스크립트명 = `sprintable`
(모듈명 `sprintable_mcp` 와 별개).
"""
from __future__ import annotations

import json

import pytest

from app.services import agent_onboarding_config as gen


def test_stdio_shape_with_key():
    cfg = gen.build_agent_mcp_config(api_key_plaintext="sk_live_abc")
    server = cfg["mcpServers"]["sprintable"]
    assert server["type"] == "stdio"
    assert server["command"] == "uvx"
    assert server["args"] == ["sprintable"]
    assert server["env"]["AGENT_API_KEY"] == "sk_live_abc"
    assert "SPRINTABLE_API_URL" in server["env"]


def test_no_phantom_keys():
    """AC1: SPRINTABLE_AGENT_ID/WS_URL/port 미포함(phantom 키 0)."""
    cfg = gen.build_agent_mcp_config(api_key_plaintext="k")
    blob = json.dumps(cfg)
    for phantom in ("SPRINTABLE_AGENT_ID", "WS_URL", "WEBSOCKET", "\"port\"", "fakechat"):
        assert phantom not in blob, f"{phantom} 가 아티팩트에 노출되면 안 됨"
    server = cfg["mcpServers"]["sprintable"]
    assert set(server.keys()) == {"type", "command", "args", "env"}


def test_key_omitted_when_absent():
    """api_key 없으면 AGENT_API_KEY 키 생략(미발급 시 비노출·AC4 호환)."""
    cfg = gen.build_agent_mcp_config(api_key_plaintext=None)
    env = cfg["mcpServers"]["sprintable"]["env"]
    assert "AGENT_API_KEY" not in env
    assert "SPRINTABLE_API_URL" in env  # URL 은 항상


def test_url_from_fastapi_url_env(monkeypatch):
    """backend-direct URL = FASTAPI_URL env(배포 주입)·trailing slash 제거."""
    monkeypatch.setenv("FASTAPI_URL", "https://sprintable-backend-dev-x.run.app/")
    cfg = gen.build_agent_mcp_config(api_key_plaintext="k")
    assert cfg["mcpServers"]["sprintable"]["env"]["SPRINTABLE_API_URL"] == \
        "https://sprintable-backend-dev-x.run.app"


def test_url_local_fallback(monkeypatch):
    """env 미설정 → localhost fallback(로컬 dev)."""
    monkeypatch.delenv("FASTAPI_URL", raising=False)
    assert gen.resolve_backend_direct_url() == "http://localhost:8000"


def test_sprintable_api_url_not_used_as_fallback(monkeypatch):
    """footgun 가드: backend env의 SPRINTABLE_API_URL(CF 도메인일 수 있음)을 절대 안 집는다(PO QA)."""
    monkeypatch.delenv("FASTAPI_URL", raising=False)
    monkeypatch.setenv("SPRINTABLE_API_URL", "https://api.sprintable.ai")  # CF 도메인 가정
    assert gen.resolve_backend_direct_url() == "http://localhost:8000"  # FASTAPI_URL만·localhost로


# ─── AC3: GET /agents/{id}/connection-artifact 엔드포인트 ──────────────────────

import uuid  # noqa: E402
from types import SimpleNamespace  # noqa: E402
from unittest.mock import AsyncMock, MagicMock  # noqa: E402


def _db_returning(member):
    """member 조회 mock + AgentPersonaRepository.list()가 쓰는 .scalars().all() 도 빈 리스트로
    안전하게 반환(E-RECRUIT S5: connection-artifact가 이제 persona 조회도 하므로 — 이 헬퍼를 쓰는
    기존 테스트들은 "persona 없음"(회귀 없는 기존 동작) 경로를 검증)."""
    res = MagicMock()
    res.scalar_one_or_none.return_value = member
    res.scalars.return_value.all.return_value = []
    db = AsyncMock()
    db.execute = AsyncMock(return_value=res)
    return db


@pytest.mark.anyio
async def test_connection_artifact_returns_stdio_with_placeholder():
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    agent_id = uuid.uuid4()
    db = _db_returning(SimpleNamespace(id=agent_id, project_id=uuid.uuid4()))
    out = await get_agent_connection_artifact(
        agent_id, runtime="claude-code", accept_language=None,
        session=db, auth=MagicMock(), org_id=uuid.uuid4()
    )
    # E-RECRUIT S5 BE↔FE 계약(story 4fca5a3e): {files[], mcp_config, api_key, agent_id, runtime}
    assert out["agent_id"] == str(agent_id)
    assert out["runtime"] == "claude-code"
    assert out["api_key"] is None  # G2: GET 재방문은 placeholder만(실키 재노출 불가)
    assert len(out["files"]) == 1  # persona 없음(mock) → .mcp.json 만(회귀 없음)
    mcp_file = out["files"][0]
    assert mcp_file["filename"] == ".mcp.json"
    assert isinstance(mcp_file["content"], str), "content 는 paste-ready json 문자열이어야(dict 아님)"
    parsed = json.loads(mcp_file["content"])
    server = parsed["mcpServers"]["sprintable"]
    assert server["type"] == "stdio"
    assert server["env"]["AGENT_API_KEY"] == "<YOUR_AGENT_API_KEY>"  # placeholder
    assert out["mcp_config"] == parsed


@pytest.mark.anyio
async def test_connection_artifact_with_persona_emits_instruction_file():
    """G4: persona(is_default)가 있으면 자율 운영 지침이 런타임별 파일명으로 files[]에 포함.

    ``AgentPersonaRepository.list()`` 내부(_decorate → _get_base/_is_in_use)는 실 DB 조회를
    거치므로, 이 라우터-계층 테스트는 그 메서드 자체를 patch(반환값만 확인)한다 — 실 DB 조회
    시맨틱은 별도 realdb 테스트가 검증."""
    from unittest.mock import patch
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    agent_id = uuid.uuid4()
    # 까심 QA RC(S5): is_default=True 명시 — list()의 정렬 순서([0])만으론 default 보장 안 됨.
    persona = SimpleNamespace(resolved_system_prompt="당신은 백엔드 엔지니어입니다.", is_default=True)
    db = _db_returning(SimpleNamespace(id=agent_id, project_id=uuid.uuid4()))

    with patch(
        "app.routers.agents.AgentPersonaRepository.list",
        new_callable=AsyncMock, return_value=[persona],
    ):
        out = await get_agent_connection_artifact(
            agent_id, runtime="claude-code", accept_language=None,
            session=db, auth=MagicMock(), org_id=uuid.uuid4()
        )
    assert len(out["files"]) == 2
    filenames = {f["filename"] for f in out["files"]}
    assert filenames == {"SPRINTABLE_ONBOARDING.md", ".mcp.json"}
    instruction_file = next(f for f in out["files"] if f["filename"] == "SPRINTABLE_ONBOARDING.md")
    assert instruction_file["content"] == "당신은 백엔드 엔지니어입니다."


@pytest.mark.anyio
async def test_connection_artifact_non_default_persona_omits_instruction_file():
    """까심 QA RC(S5): personas[0]가 is_default=False면(list() 정렬만으론 default 안 보장) 지침
    파일을 emit하면 안 됨 — 안전 fallback으로 생략(.mcp.json만)."""
    from unittest.mock import patch
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    agent_id = uuid.uuid4()
    persona = SimpleNamespace(resolved_system_prompt="이건 authoritative 아님.", is_default=False)
    db = _db_returning(SimpleNamespace(id=agent_id, project_id=uuid.uuid4()))

    with patch(
        "app.routers.agents.AgentPersonaRepository.list",
        new_callable=AsyncMock, return_value=[persona],
    ):
        out = await get_agent_connection_artifact(
            agent_id, runtime="claude-code", accept_language=None,
            session=db, auth=MagicMock(), org_id=uuid.uuid4()
        )
    assert len(out["files"]) == 1
    assert out["files"][0]["filename"] == ".mcp.json"


@pytest.mark.anyio
async def test_connection_artifact_connector_runtime_returns_pointer_only():
    """Q2(PO 확정): connector 런타임은 `.mcp.json` 없이 포인터/안내 파일만."""
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    agent_id = uuid.uuid4()
    db = _db_returning(SimpleNamespace(id=agent_id, project_id=uuid.uuid4()))
    out = await get_agent_connection_artifact(
        agent_id, runtime="connector", accept_language=None,
        session=db, auth=MagicMock(), org_id=uuid.uuid4()
    )
    assert out["mcp_config"] is None
    assert len(out["files"]) == 1
    assert out["files"][0]["filename"] == "CONNECTOR_SETUP.md"
    assert "connectors/" in out["files"][0]["content"]


@pytest.mark.anyio
async def test_connection_artifact_connector_guidance_locale_from_explicit_query():
    """E-I18N Phase C: locale 쿼리 파라미터가 CONNECTOR_SETUP.md 내용에 반영."""
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    agent_id = uuid.uuid4()
    db = _db_returning(SimpleNamespace(id=agent_id, project_id=uuid.uuid4()))
    out = await get_agent_connection_artifact(
        agent_id, runtime="grok", locale="en", session=db, auth=MagicMock(), org_id=uuid.uuid4()
    )
    content = out["files"][0]["content"]
    assert "# Sprintable Connector Guide" in content
    assert "# Sprintable Connector 안내" not in content


@pytest.mark.anyio
async def test_connection_artifact_connector_guidance_locale_from_accept_language_fallback():
    """locale 쿼리 미지정 시 Accept-Language 헤더로 폴백."""
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    agent_id = uuid.uuid4()
    db = _db_returning(SimpleNamespace(id=agent_id, project_id=uuid.uuid4()))
    out = await get_agent_connection_artifact(
        agent_id, runtime="grok", accept_language="en-US,en;q=0.9",
        session=db, auth=MagicMock(), org_id=uuid.uuid4(),
    )
    content = out["files"][0]["content"]
    assert "# Sprintable Connector Guide" in content


@pytest.mark.anyio
async def test_connection_artifact_connector_guidance_no_locale_signal_stays_korean():
    """locale도 Accept-Language도 없으면(기존 호출부 무변경) 기존과 동일한 한글 출력."""
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    agent_id = uuid.uuid4()
    db = _db_returning(SimpleNamespace(id=agent_id, project_id=uuid.uuid4()))
    out = await get_agent_connection_artifact(
        agent_id, runtime="grok", accept_language=None,
        session=db, auth=MagicMock(), org_id=uuid.uuid4()
    )
    content = out["files"][0]["content"]
    assert "# Sprintable Connector 안내" in content


@pytest.mark.anyio
async def test_connection_artifact_unsupported_runtime_400():
    """전 런타임 올지원(story 6f6ac081) 후: RuntimeType 9종 전부 SUPPORTED_RUNTIMES에 포함돼
    (hermes 등 예전엔 400이던 값도 이제 지원) — 400 가드는 RuntimeType에도 없는 완전 미지의
    문자열에만 여전히 걸려야 한다(방어 가드 자체는 무회귀)."""
    from fastapi import HTTPException

    from app.routers.agents import _connection_artifact as get_agent_connection_artifact
    with pytest.raises(HTTPException) as ei:
        await get_agent_connection_artifact(
            uuid.uuid4(), runtime="totally-unknown-runtime", session=AsyncMock(),
            auth=MagicMock(), org_id=uuid.uuid4(),
        )
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_connection_artifact_not_found_404():
    from fastapi import HTTPException

    from app.routers.agents import _connection_artifact as get_agent_connection_artifact
    db = _db_returning(None)
    with pytest.raises(HTTPException) as ei:
        await get_agent_connection_artifact(
            uuid.uuid4(), runtime="claude-code", accept_language=None,
            session=db, auth=MagicMock(), org_id=uuid.uuid4()
        )
    assert ei.value.status_code == 404


# ── E-I18N Phase A(story 11f1087c) — resolve_locale SSOT ───────────────────────

def test_supported_locales_matches_fe_exactly():
    """FE apps/web/src/i18n/request.ts의 SUPPORTED_LOCALES=['en','ko']와 값 일치(순서 무관,
    집합 동일) — 어긋나면 "FE는 지원한다는데 BE가 거부" 류 불일치 버그 재발."""
    assert set(gen.SUPPORTED_LOCALES) == {"en", "ko"}


def test_resolve_locale_passthrough_for_supported():
    assert gen.resolve_locale("en") == "en"
    assert gen.resolve_locale("ko") == "ko"


def test_resolve_locale_falls_back_to_default_for_unsupported_or_none():
    assert gen.resolve_locale("fr") == gen.DEFAULT_LOCALE
    assert gen.resolve_locale(None) == gen.DEFAULT_LOCALE
    assert gen.resolve_locale("") == gen.DEFAULT_LOCALE


def test_default_locale_is_korean():
    """FE 기본값(en, "방문자 신호 0"용)과 의도적으로 다르다 — BE는 오늘 실 콘텐츠가 있는
    locale(ko)이 안전한 폴백(en 콘텐츠는 아직 없음, Phase A 스코프)."""
    assert gen.DEFAULT_LOCALE == "ko"


# ── E-I18N Phase C(story 11f1087c) — locale 소스 배선(FE 명시→Accept-Language 폴백) ──────

def test_resolve_locale_from_request_prefers_explicit_over_header():
    assert gen.resolve_locale_from_request("en", "ko-KR,ko;q=0.9") == "en"


def test_resolve_locale_from_request_falls_back_to_accept_language_header():
    assert gen.resolve_locale_from_request(None, "en-US,en;q=0.9,ko;q=0.8") == "en"
    assert gen.resolve_locale_from_request(None, "ko-KR,ko;q=0.9") == "ko"


def test_resolve_locale_from_request_ignores_unsupported_header_tags():
    """Accept-Language가 미지원 언어들뿐이면(fr 등) DEFAULT_LOCALE로 폴백 — 크래시 없음."""
    assert gen.resolve_locale_from_request(None, "fr-FR,fr;q=0.9,de;q=0.8") == gen.DEFAULT_LOCALE


def test_resolve_locale_from_request_no_signal_falls_back_to_default():
    assert gen.resolve_locale_from_request(None, None) == gen.DEFAULT_LOCALE


def test_resolve_locale_from_request_explicit_unsupported_falls_back_to_default():
    """explicit이 있어도 미지원 값이면(resolve_locale 위임) DEFAULT_LOCALE — 헤더로 폴백하지
    않는다(명시 전달 우선순위가 명확히 이겼으면 그 판단을 신뢰, 헤더 재시도는 안 함)."""
    assert gen.resolve_locale_from_request("fr", "en-US,en;q=0.9") == gen.DEFAULT_LOCALE


# ── E-I18N Phase C — build_connector_guidance locale 분기 ──────────────────────────

def test_build_connector_guidance_default_locale_is_korean_backward_compatible():
    """까심 QA MUST-FIX(2026-07-08, #1966): substring만 체크하면 dict화 과정에서 원문 줄바꿈이
    사라지는 byte-diff를 못 잡는다(실제로 한 번 놓쳤다) — default-ko 출력이 dict화 이전 원문
    리터럴과 정확히 byte-identical 인지 직접 assert한다."""
    out = gen.build_connector_guidance("grok")
    expected = "\n".join([
        "# Sprintable Connector 안내",
        "",
        "(선택한 런타임: grok)",
        "Claude Code/Codex/Gemini/Cursor 처럼 MCP를 네이티브 지원하지 않는 런타임은 별도 SSE",
        "커넥터 어댑터로 연결합니다 — `.mcp.json`이 아니라 `connectors/{runtime}-sprintable/` 폴더의",
        "어댑터를 사용해 서버에 아웃바운드로 접속합니다(인바운드 도메인/웹훅 불필요).",
        "",
        "## 사용 가능한 어댑터",
        "`connectors/` 레포 경로 아래 각 폴더가 자기완결(self-contained) 어댑터입니다:",
        "hermes-sprintable · openclaw-sprintable · opencode-sprintable · grok-sprintable ·",
        "pi-sprintable · codex-sprintable · cursor-sprintable · gemini-sprintable",
        "",
        "## 설정",
        "1. 위 폴더 중 사용 중인 런타임에 맞는 폴더를 복사하세요(각 폴더는 sibling import 없이",
        "   독립 동작합니다).",
        "2. 폴더의 `README.md` 안내대로 `AGENT_API_KEY`(이 에이전트의 scoped key) 등 env를 설정하세요.",
        "3. 어댑터를 런타임 호스트에서 직접 실행하세요(호스팅 실행은 지원하지 않음 — 설치/실행은",
        "   사용자 수동).",
    ])
    assert out == expected


def test_build_connector_guidance_english_locale():
    out = gen.build_connector_guidance("grok", locale="en")
    assert "# Sprintable Connector Guide" in out
    assert "(Selected runtime: grok)" in out
    assert "## Available Adapters" in out
    assert "## Setup" in out
    assert "# Sprintable Connector 안내" not in out
    assert "선택한 런타임" not in out


def test_build_connector_guidance_unsupported_locale_falls_back_to_default():
    out = gen.build_connector_guidance(locale="fr")
    assert "# Sprintable Connector 안내" in out
