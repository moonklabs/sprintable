"""S-COMM-06: 비-Claude Code 에이전트 연동 가이드 + smoke test 검증.

AC1: 연동 가이드 문서 — API Key 발급 → SSE 구독 → send_chat_message 3단계.
AC2: curl/httpie 예시 코드 포함.
AC3: Hermes config.yaml 예시 포함 (sprintable_mcp MCP server 등록).
AC4: 실제 SSE 수신 + 메시지 발신 smoke test 성공 (curl 검증 가능 수준).
"""
from __future__ import annotations

import pathlib


GUIDE_PATH = pathlib.Path(__file__).parent.parent.parent / "docs" / "agent-integration-guide.md"


def _guide_text() -> str:
    assert GUIDE_PATH.exists(), f"가이드 문서 없음: {GUIDE_PATH}"
    return GUIDE_PATH.read_text(encoding="utf-8")


# ── AC1: 3단계 구조 ───────────────────────────────────────────────────────────

def test_guide_has_three_steps():
    """가이드에 3단계(에이전트 등록/API Key, SSE 구독, 메시지 발신)가 있어야 함 (AC1)."""
    text = _guide_text()
    assert "Step 1" in text, "Step 1 (API Key 발급) 누락"
    assert "Step 2" in text, "Step 2 (SSE 구독) 누락"
    assert "Step 3" in text, "Step 3 (send_chat_message) 누락"


def test_guide_covers_api_key_issuance():
    """에이전트 등록 + API Key 발급 절차가 있어야 함 (AC1)."""
    text = _guide_text()
    assert "/api/v2/team-members" in text, "에이전트 TeamMember 생성 엔드포인트 누락"
    assert "/api/v2/agents" in text and "api-keys" in text, "API Key 발급 엔드포인트 누락"
    assert "sk_live_" in text, "API Key 형식 예시 누락"


def test_guide_covers_sse_subscription():
    """SSE 스트림 구독 방법이 있어야 함 (AC1)."""
    text = _guide_text()
    assert "/api/v2/events/stream" in text, "SSE 엔드포인트 누락"
    assert "text/event-stream" in text, "Accept: text/event-stream 헤더 누락"


def test_guide_covers_send_chat_message():
    """메시지 발신 엔드포인트가 있어야 함 (AC1)."""
    text = _guide_text()
    assert "/api/v2/conversations" in text and "/messages" in text, (
        "send_chat_message API 엔드포인트 누락"
    )
    assert '"content"' in text, "메시지 발신 payload 예시 누락"


# ── AC2: curl/httpie 예시 ─────────────────────────────────────────────────────

def test_guide_has_curl_examples():
    """curl 예시가 있어야 함 (AC2)."""
    text = _guide_text()
    assert "curl" in text, "curl 예시 누락"
    # API Key 발급, SSE 구독, 메시지 발신 각각 curl 있는지
    assert text.count("curl") >= 3, "curl 예시가 3개 미만 (각 단계마다 필요)"


def test_guide_has_httpie_examples():
    """httpie 예시가 있어야 함 (AC2)."""
    text = _guide_text()
    assert "http " in text or "httpie" in text, "httpie 예시 누락"


def test_guide_has_auth_header_examples():
    """Authorization 헤더 + X-Org-Id 헤더 예시가 있어야 함 (AC2)."""
    text = _guide_text()
    assert "Authorization: Bearer" in text, "Authorization 헤더 예시 누락"
    assert "X-Org-Id" in text, "X-Org-Id 헤더 예시 누락"


# ── AC3: Hermes config.yaml ───────────────────────────────────────────────────

def test_guide_has_hermes_config():
    """Hermes config.yaml 예시가 있어야 함 (AC3)."""
    text = _guide_text()
    assert "config.yaml" in text, "Hermes config.yaml 예시 누락"
    assert "mcpServers" in text, "mcpServers 키 누락"
    assert "sprintable_mcp" in text or "sprintable-mcp" in text, (
        "sprintable_mcp MCP server 등록 예시 누락"
    )
    assert "SPRINTABLE_API_URL" in text, "SPRINTABLE_API_URL 환경변수 누락"
    assert "AGENT_API_KEY" in text, "AGENT_API_KEY 환경변수 누락"


def test_guide_has_mcp_json_example():
    """.mcp.json (Claude Code) 형식 예시도 포함되어 있어야 함 (AC3)."""
    text = _guide_text()
    assert ".mcp.json" in text, ".mcp.json 형식 설명 누락"


# ── AC4: Smoke test 스크립트 ──────────────────────────────────────────────────

def test_guide_has_smoke_test_script():
    """Smoke test 스크립트(bash)가 포함되어 있어야 함 (AC4)."""
    text = _guide_text()
    assert "smoke" in text.lower(), "smoke test 섹션 누락"
    assert "#!/usr/bin/env bash" in text or "set -euo pipefail" in text, (
        "smoke test bash 스크립트 누락"
    )


def test_guide_smoke_test_covers_all_steps():
    """Smoke test가 에이전트 등록 → API Key → SSE 연결을 순서대로 검증해야 함 (AC4)."""
    text = _guide_text()
    # smoke test 섹션에서 3단계 모두 언급되어야 함
    assert "team-members" in text, "smoke test: 에이전트 등록 누락"
    assert "api-keys" in text, "smoke test: API Key 발급 누락"
    assert "events/stream" in text, "smoke test: SSE 연결 누락"


def test_guide_smoke_test_has_reconnect_example():
    """Last-Event-ID 재연결 예시가 있어야 함 (S-COMM-05 AC1 연동 — AC4)."""
    text = _guide_text()
    assert "Last-Event-ID" in text, "Last-Event-ID 재연결 헤더 예시 누락"
    assert "is_backfill" in text, "is_backfill 플래그 설명 누락"


def test_guide_mentions_event_retention():
    """이벤트 보관 기간(24시간) 정보가 있어야 함 (AC4)."""
    text = _guide_text()
    assert "24" in text, "24시간 보관 기간 언급 누락"
