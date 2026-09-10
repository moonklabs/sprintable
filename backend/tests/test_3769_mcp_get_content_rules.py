"""story #3769(2026-09-10) — sprintable_get_content_rules MCP 도구.

`content_rules.py:4-7`의 docstring(story #3471)이 약속한 「에이전트가 GET으로 읽는」 길이
`backend/sprintable_mcp/tools/*`에 0건이었다(BE는 이미 org 멤버 자격으로 열려 있었다).
이 도구는 그 갭을 메운다 — BE 신설 0(기존 GET 둘을 그대로 호출·병합), 필드명 새로 안 짓는다
(get_loop_context 동형 얇은 HTTP 래퍼 패턴).
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _client(org_id: str = "org-1"):
    c = MagicMock()
    c.org_id = org_id
    return c


@pytest.mark.anyio
async def test_get_content_rules_calls_both_endpoints_and_merges():
    from sprintable_mcp.tools import content_rules as cr

    rules_payload = {
        "org_id": "org-1", "version": 3,
        "rules": {
            "tone": "친근하되 과장 없이", "taxonomy": ["product", "engineering"],
            "channel_priority": ["threads", "site"], "brand_kit": {"primary_color": "#1a73e8"},
            "banned_terms": ["spam"], "require_utm": True,
        },
    }
    budget_payload = {
        "limit_minor": 500000, "currency": "KRW", "period": "month",
        "period_start": "2026-09-01T00:00:00Z", "period_end": "2026-10-01T00:00:00Z",
        "spent_minor": 10000, "remaining_minor": 490000,
    }

    calls: list[str] = []

    async def fake_get(path, **_kw):
        calls.append(path)
        if path.endswith("/content-rules"):
            return rules_payload
        if path.endswith("/generation-budget"):
            return budget_payload
        raise AssertionError(f"unexpected path {path}")

    client = _client(org_id="org-1")
    client.get = AsyncMock(side_effect=fake_get)
    with patch.object(cr, "client", client):
        out = await cr.get_content_rules(cr.GetContentRulesInput())

    assert calls == [
        "/api/v2/organizations/org-1/content-rules",
        "/api/v2/organizations/org-1/generation-budget",
    ]
    data = json.loads(out[0].text)
    # 필드명 그대로(재선언 0) — rules 본문이 그대로 들어있다.
    assert data["rules"]["tone"] == "친근하되 과장 없이"
    assert data["rules"]["taxonomy"] == ["product", "engineering"]
    assert data["rules"]["channel_priority"] == ["threads", "site"]
    assert data["rules"]["brand_kit"] == {"primary_color": "#1a73e8"}
    assert data["rules"]["banned_terms"] == ["spam"]
    assert data["rules"]["require_utm"] is True
    assert data["version"] == 3
    assert data["org_id"] == "org-1"
    assert data["generation_budget_status"] == budget_payload


@pytest.mark.anyio
async def test_get_content_rules_empty_org_passes_through_rules_empty_dict():
    """AC — 규칙 미설정 org는 rules:{}·version:0 그대로(「없다」를 지어내지 않는다)."""
    from sprintable_mcp.tools import content_rules as cr

    async def fake_get(path, **_kw):
        if path.endswith("/content-rules"):
            return {"org_id": "org-2", "rules": {}, "version": 0}
        return {
            "limit_minor": None, "currency": None, "period": None, "period_start": None,
            "period_end": None, "spent_minor": None, "remaining_minor": None,
        }

    client = _client(org_id="org-2")
    client.get = AsyncMock(side_effect=fake_get)
    with patch.object(cr, "client", client):
        out = await cr.get_content_rules(cr.GetContentRulesInput())

    data = json.loads(out[0].text)
    assert data["rules"] == {}
    assert data["version"] == 0
    assert data["generation_budget_status"]["limit_minor"] is None


@pytest.mark.anyio
async def test_get_content_rules_uses_caller_org_no_cross_org_param():
    """구조적 타org 차단 — 입력 스키마에 org_id 파라미터 자체가 없다(withdraw_channel_post_draft
    동형 org-scoped URL 조립, client.org_id만 사용)."""
    from sprintable_mcp.tools import content_rules as cr

    assert "org_id" not in cr.GetContentRulesInput.model_fields
    with pytest.raises(Exception):
        cr.GetContentRulesInput(org_id="other-org")


@pytest.mark.anyio
async def test_get_content_rules_wraps_exception_as_err():
    from sprintable_mcp.tools import content_rules as cr

    client = _client()
    client.get = AsyncMock(side_effect=RuntimeError("boom"))
    with patch.object(cr, "client", client):
        out = await cr.get_content_rules(cr.GetContentRulesInput())
    assert out[0].text == "Error: boom"


# ── toolset 등재(SSOT+vendored, catalog) ────────────────────────────────────────

def test_get_content_rules_registered_in_all_tool_names():
    from app.services.mcp_toolset import ALL_TOOL_NAMES
    assert "sprintable_get_content_rules" in ALL_TOOL_NAMES


def test_get_content_rules_grouped_as_content_ssot_and_vendored():
    from app.services.mcp_toolset import tool_group as ssot_group
    from sprintable_mcp.toolset import tool_group as vendored_group
    assert ssot_group("sprintable_get_content_rules") == "content"
    assert vendored_group("sprintable_get_content_rules") == "content"


def test_get_content_rules_allowed_with_content_scope_blocked_without():
    from app.services.mcp_toolset import is_tool_allowed as ssot_allowed
    from sprintable_mcp.toolset import is_tool_allowed as vendored_allowed
    assert ssot_allowed("sprintable_get_content_rules", ["content"])
    assert vendored_allowed("sprintable_get_content_rules", ["content"])
    assert not ssot_allowed("sprintable_get_content_rules", ["stories"])
    assert not vendored_allowed("sprintable_get_content_rules", ["stories"])
    # scope 미지정(레거시)은 비파괴 전체 허용 — get_content_rules는 파괴적이지 않다.
    assert ssot_allowed("sprintable_get_content_rules", [])
    assert vendored_allowed("sprintable_get_content_rules", [])


def test_get_content_rules_registered_in_server_tool_defs():
    """server.py `_TOOL_DEFS`(실 MCP 등록)에 실제로 얹혀 있는지 — ALL_TOOL_NAMES 등재만으론
    tools/list 노출을 보장 못한다(story #2010/#1922와 동일 회귀 클래스)."""
    from sprintable_mcp.server import _TOOL_DEFS
    names = {t[0] for t in _TOOL_DEFS}
    assert "sprintable_get_content_rules" in names


# ── REST 직접호출 scope 게이트(story #3654 표 동기화) ────────────────────────────

def test_content_rules_rest_path_now_mapped_to_content_group():
    from app.services.mcp_toolset import path_allowed_for_scope, path_to_tool_group
    path = "/api/v2/organizations/org-1/content-rules"
    assert path_to_tool_group(path) == "content"
    assert path_allowed_for_scope(path, ["stories"]) is False
    assert path_allowed_for_scope(path, ["content"]) is True
