"""OB-2-align: 신규 에이전트를 V2 게이트웨이(/agent/stream)로 통일 가드.

통합 dogfood 적출: generator가 AGENT_GATEWAY_V2를 안 박아 신규 에이전트가 구 /events/stream
default → AgentGatewaySession 미생성 → verify mcp_reachable false-negative. fix=아티팩트 env에
AGENT_GATEWAY_V2="1" → V2 통일(서버 무변경·verify 코드 무변경·verified-green 정렬).
"""
from __future__ import annotations

from app.services.agent_onboarding_config import build_agent_mcp_config


def test_artifact_pins_agent_gateway_v2():
    """신규 아티팩트 env에 AGENT_GATEWAY_V2='1' — 신규 에이전트 V2(/agent/stream) 통일."""
    env = build_agent_mcp_config(api_key_plaintext="k")["mcpServers"]["sprintable"]["env"]
    assert env["AGENT_GATEWAY_V2"] == "1"


def test_v2_flag_present_even_without_key():
    """키 미발급(connection-artifact placeholder 경로)에도 V2 flag는 항상 — 전 신규 에이전트 V2."""
    env = build_agent_mcp_config(api_key_plaintext=None)["mcpServers"]["sprintable"]["env"]
    assert env["AGENT_GATEWAY_V2"] == "1"
    assert env["SPRINTABLE_API_URL"]  # backend-direct 도 항상


def test_v2_flag_value_is_truthy_for_sse_bridge():
    """sse_bridge `_use_v2`(os.getenv not in ('0','false',''))가 truthy로 보는 값이어야 V2 발효."""
    env = build_agent_mcp_config(api_key_plaintext="k")["mcpServers"]["sprintable"]["env"]
    assert env["AGENT_GATEWAY_V2"] not in ("0", "false", "")
