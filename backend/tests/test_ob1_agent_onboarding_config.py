"""OB-1: agent_onboarding_config SSOT generator 가드 (블루프린트 §2/§7).

AC1: stdio .mcp.json(type=stdio·uvx·sprintable-mcp·env{SPRINTABLE_API_URL=backend-direct,
AGENT_API_KEY})·AGENT_ID/WS_URL/port 미포함. backend-direct URL=env(FASTAPI_URL)·CF 금지·local fallback.
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
    assert server["args"] == ["sprintable-mcp"]
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
    from app.routers.agents import get_agent_connection_artifact

    agent_id = uuid.uuid4()
    db = _db_returning(SimpleNamespace(id=agent_id, project_id=uuid.uuid4()))
    out = await get_agent_connection_artifact(
        agent_id, runtime="claude-code", session=db, auth=MagicMock(), org_id=uuid.uuid4()
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
    from app.routers.agents import get_agent_connection_artifact

    agent_id = uuid.uuid4()
    persona = SimpleNamespace(resolved_system_prompt="당신은 백엔드 엔지니어입니다.")
    db = _db_returning(SimpleNamespace(id=agent_id, project_id=uuid.uuid4()))

    with patch(
        "app.routers.agents.AgentPersonaRepository.list",
        new_callable=AsyncMock, return_value=[persona],
    ):
        out = await get_agent_connection_artifact(
            agent_id, runtime="claude-code", session=db, auth=MagicMock(), org_id=uuid.uuid4()
        )
    assert len(out["files"]) == 2
    filenames = {f["filename"] for f in out["files"]}
    assert filenames == {"CLAUDE.md", ".mcp.json"}
    instruction_file = next(f for f in out["files"] if f["filename"] == "CLAUDE.md")
    assert instruction_file["content"] == "당신은 백엔드 엔지니어입니다."


@pytest.mark.anyio
async def test_connection_artifact_connector_runtime_returns_pointer_only():
    """Q2(PO 확정): connector 런타임은 `.mcp.json` 없이 포인터/안내 파일만."""
    from app.routers.agents import get_agent_connection_artifact

    agent_id = uuid.uuid4()
    db = _db_returning(SimpleNamespace(id=agent_id, project_id=uuid.uuid4()))
    out = await get_agent_connection_artifact(
        agent_id, runtime="connector", session=db, auth=MagicMock(), org_id=uuid.uuid4()
    )
    assert out["mcp_config"] is None
    assert len(out["files"]) == 1
    assert out["files"][0]["filename"] == "CONNECTOR_SETUP.md"
    assert "connectors/" in out["files"][0]["content"]


@pytest.mark.anyio
async def test_connection_artifact_unsupported_runtime_400():
    """Q1(PO 확정): S5 SUPPORTED_RUNTIMES는 S4 픽커 5종(claude-code/codex/gemini/cursor/connector)
    으로 좁혔다 — RuntimeType 의 다른 9종 중 미채택 값(예: hermes)은 여전히 400."""
    from fastapi import HTTPException

    from app.routers.agents import get_agent_connection_artifact
    with pytest.raises(HTTPException) as ei:
        await get_agent_connection_artifact(
            uuid.uuid4(), runtime="hermes", session=AsyncMock(), auth=MagicMock(), org_id=uuid.uuid4()
        )
    assert ei.value.status_code == 400


@pytest.mark.anyio
async def test_connection_artifact_not_found_404():
    from fastapi import HTTPException

    from app.routers.agents import get_agent_connection_artifact
    db = _db_returning(None)
    with pytest.raises(HTTPException) as ei:
        await get_agent_connection_artifact(
            uuid.uuid4(), runtime="claude-code", session=db, auth=MagicMock(), org_id=uuid.uuid4()
        )
    assert ei.value.status_code == 404
