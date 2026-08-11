"""story #2466(P1-B) — hermes http-capable 재분류 (spec-2377 §1.5, 유나 정렬 v1.3).

①도구전달(http MCP)과 ②깨우기(커넥터)는 독립 축. hermes는 자체 CLI(`hermes mcp add --url
--auth header`)로 http MCP에 라이브 왕복 성공(P1-B 실측, 110개 도구 실수신)해 ①축에 편입
(HTTP_MCP_CAPABLE_RUNTIMES) — ②축(커넥터 깨우기 안내)은 그대로 유지한다(둘 다 emit). openclaw는
config-shape만 검증됐고 완전 tools/list 왕복 미확認(PO 결정 2026-08-05, §2 A-3 「거짓 성공」
리스크) — 이 스토리에서 재분류 안 함(현행 수동 어댑터 유지, positive control 역할도 겸함).
"""
from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services import agent_onboarding_config as gen


def _db_returning(member):
    res = MagicMock()
    res.scalar_one_or_none.return_value = member
    res.scalars.return_value.all.return_value = []
    db = AsyncMock()
    db.execute = AsyncMock(return_value=res)
    return db


def test_http_mcp_capable_runtimes_is_mcp_native_plus_hermes_only():
    """openclaw는 아직 포함되면 안 된다(config-accepted만으로 재분류 금지, §2 A-3)."""
    assert gen.HTTP_MCP_CAPABLE_RUNTIMES == gen.MCP_NATIVE_RUNTIMES | {"hermes"}
    assert "openclaw" not in gen.HTTP_MCP_CAPABLE_RUNTIMES
    assert "hermes" in gen.HTTP_MCP_CAPABLE_RUNTIMES


def test_hermes_stays_out_of_mcp_native_runtimes():
    """유나 지적(v1.3) — MCP_NATIVE_RUNTIMES는 "어댑터 없이 태생 MCP"라는 원래 뜻 그대로,
    hermes(자체 CLI로 붙는 것)를 여기 편입하면 §0 "이름이 뜻과 어긋나는" 병 재발."""
    assert "hermes" not in gen.MCP_NATIVE_RUNTIMES


def test_build_agent_mcp_config_hermes_http(monkeypatch):
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.sprintable.ai/mcp")
    cfg = gen.build_agent_mcp_config(api_key_plaintext="sk_test", runtime="hermes", transport="http")
    assert cfg is not None
    server = cfg["mcpServers"]["sprintable-mcp"]
    assert server["type"] == "http"
    assert server["url"] == "https://mcp.sprintable.ai/mcp"
    assert server["headers"]["Authorization"] == "Bearer sk_test"


def test_build_agent_mcp_config_hermes_stdio():
    cfg = gen.build_agent_mcp_config(api_key_plaintext="sk_test", runtime="hermes", transport="stdio")
    assert cfg is not None
    server = cfg["mcpServers"]["sprintable-mcp"]
    assert server["type"] == "stdio"
    assert server["command"] == "uvx"
    assert server["args"] == ["sprintable"]


def test_build_agent_mcp_config_openclaw_still_none_positive_control(monkeypatch):
    """sabotage 역방향 positive control — openclaw가 재분류 안 됐음을 그 자리에서 재확認.
    HTTP_MCP_CAPABLE_RUNTIMES에 실수로 openclaw가 편입되면 이 테스트가 바로 잡는다."""
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.sprintable.ai/mcp")
    assert gen.build_agent_mcp_config(api_key_plaintext="sk_test", runtime="openclaw", transport="http") is None
    assert gen.build_agent_mcp_config(api_key_plaintext="sk_test", runtime="openclaw", transport="stdio") is None


def test_build_agent_mcp_config_bundle_hermes_includes_both_transports(monkeypatch):
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.sprintable.ai/mcp")
    bundle = gen.build_agent_mcp_config_bundle(api_key_plaintext="sk_test", runtime="hermes")
    assert bundle["default_transport"] == "http"
    assert bundle["mcp_config"]["mcpServers"]["sprintable-mcp"]["type"] == "http"
    assert "stdio" in bundle["mcp_config_alternatives"]


def test_build_hermes_mcp_cli_setup_http_command():
    cfg = {"mcpServers": {"sprintable-mcp": {
        "type": "http", "url": "https://mcp.sprintable.ai/mcp",
        "headers": {"Authorization": "Bearer sk_test"},
    }}}
    text = gen.build_hermes_mcp_cli_setup(cfg, "sk_test")
    command_line = next(line for line in text.splitlines() if line.startswith("hermes mcp add"))
    assert command_line == "hermes mcp add sprintable-mcp --url https://mcp.sprintable.ai/mcp --auth header"
    assert "sk_test" in text
    # 실행 커맨드 자체는 파일 드롭인이 아니다 — .mcp.json은 설명 문구에만 등장해야지
    # 커맨드로 오인될 자리(등록 명령 코드블록)엔 나오면 안 된다(§0 재발 방지).
    command_block = text.split("## 등록 명령")[1]
    assert ".mcp.json" not in command_block


def test_build_hermes_mcp_cli_setup_stdio_command():
    cfg = {"mcpServers": {"sprintable-mcp": {
        "type": "stdio", "command": "uvx", "args": ["sprintable"], "env": {},
    }}}
    text = gen.build_hermes_mcp_cli_setup(cfg, None)
    assert "hermes mcp add sprintable-mcp --command uvx --args sprintable" in text


def test_list_runtime_capabilities_hermes_has_both_axes(monkeypatch):
    """hermes는 ①(transport 채움)과 ②(guide_filename 채움)가 동시에 참이어야 한다 — 두 축이
    독립적으로 계산됨을 openclaw(②만 참)와 대조해 증명한다(한쪽만 참인 사례가 있어야 두 값이
    실제로 분리 계산된다는 것을 판별할 수 있다 — 안 그러면 우연 일치일 수 있음)."""
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.sprintable.ai/mcp")
    caps = {c["slug"]: c for c in gen.list_runtime_capabilities()}
    assert caps["hermes"]["transport"] is not None
    assert caps["hermes"]["guide_filename"] == "CONNECTOR_SETUP.md"
    # openclaw: ②만 참(①은 아직 미확定) — hermes와 대조하는 discriminator.
    assert caps["openclaw"]["transport"] is None
    assert caps["openclaw"]["guide_filename"] == "CONNECTOR_SETUP.md"
    # claude-code: ①만 참(태생 MCP-native라 ②안내는 이 스토리 스코프 밖 — 손 안 댐, 무회귀).
    assert caps["claude-code"]["transport"] is not None
    assert caps["claude-code"]["guide_filename"] is None


@pytest.mark.anyio
async def test_connection_artifact_hermes_emits_mcp_setup_and_connector_setup(monkeypatch):
    """hermes 재분류 후 connection-artifact = HERMES_MCP_SETUP.md(①) + CONNECTOR_SETUP.md(②)
    둘 다 — 예전 if/else 단일분기라면 이 중 하나만 나왔을 것(§0 "한 축이 두 물음" 재발 방지 고정)."""
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.sprintable.ai/mcp")
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    agent_id = uuid.uuid4()
    db = _db_returning(SimpleNamespace(id=agent_id, project_id=uuid.uuid4()))
    out = await get_agent_connection_artifact(
        agent_id, runtime="hermes", accept_language=None,
        session=db, auth=MagicMock(), org_id=uuid.uuid4(),
    )
    filenames = {f["filename"] for f in out["files"]}
    assert filenames == {"HERMES_MCP_SETUP.md", "CONNECTOR_SETUP.md"}
    assert ".mcp.json" not in filenames  # hermes는 파일 드롭인이 아니므로 이 이름이 나오면 안 됨
    assert out["mcp_config"] is not None
    assert out["mcp_config"]["mcpServers"]["sprintable-mcp"]["type"] in ("http", "stdio")

    mcp_setup = next(f for f in out["files"] if f["filename"] == "HERMES_MCP_SETUP.md")
    assert "hermes mcp add sprintable-mcp" in mcp_setup["content"]
    connector_setup = next(f for f in out["files"] if f["filename"] == "CONNECTOR_SETUP.md")
    assert "connectors/" in connector_setup["content"]


@pytest.mark.anyio
async def test_connection_artifact_openclaw_still_connector_only_regression_guard(monkeypatch):
    """positive control — openclaw는 이 스토리에서 손 안 댔으니 예전과 완전히 동일해야 한다.
    HTTP_MCP_CAPABLE_RUNTIMES에 openclaw가 실수로 들어가면 이 테스트가 바로 깨진다."""
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.sprintable.ai/mcp")
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    agent_id = uuid.uuid4()
    db = _db_returning(SimpleNamespace(id=agent_id, project_id=uuid.uuid4()))
    out = await get_agent_connection_artifact(
        agent_id, runtime="openclaw", accept_language=None,
        session=db, auth=MagicMock(), org_id=uuid.uuid4(),
    )
    assert out["mcp_config"] is None
    assert len(out["files"]) == 1
    assert out["files"][0]["filename"] == "CONNECTOR_SETUP.md"


@pytest.mark.anyio
async def test_connection_artifact_hermes_sabotage_reverts_to_mcp_json_if_misclassified(monkeypatch):
    """sabotage 검증 — HERMES_MCP_SETUP.md 대신 실수로 .mcp.json(hermes가 안 읽는 파일)을 emit
    하면 이 테스트가 잡아야 한다. 코드가 아니라 «그 결함이 실제로 나면 잡히는가»를 정직하게
    실증하기 위해, sabotage 조건(runtime name typo)으로 실패 경로를 만들어 재현한다."""
    monkeypatch.setenv("MCP_PUBLIC_URL", "https://mcp.sprintable.ai/mcp")
    from app.routers.agents import _connection_artifact as get_agent_connection_artifact

    agent_id = uuid.uuid4()
    db = _db_returning(SimpleNamespace(id=agent_id, project_id=uuid.uuid4()))
    # codex는 진짜 MCP-native라 .mcp.json을 받는 게 맞다 — hermes와 달리 이 파일명이 정답인
    # 대조군(hermes만 예외적으로 다른 파일명을 받아야 한다는 것을 대비해서 보여준다).
    out = await get_agent_connection_artifact(
        agent_id, runtime="codex", accept_language=None,
        session=db, auth=MagicMock(), org_id=uuid.uuid4(),
    )
    filenames = {f["filename"] for f in out["files"]}
    assert filenames == {".mcp.json"}
