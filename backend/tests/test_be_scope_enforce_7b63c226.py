"""7b63c226: BE 엔드포인트 path→group 서버사이드 scope 강제 (MCP 클라 우회 차단).

그룹-scoped 키가 BE 엔드포인트를 직접 호출해도 키 scope 외 그룹은 403. 일반키(read/write) 무회귀·
always-allowed(core) 면제. 그룹 소스는 MCP tool_group 과 동일(ALL_GROUPS·resolve_policy).
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.dependencies.auth import _check_api_key_scope
from app.services.mcp_toolset import path_allowed_for_scope, path_to_tool_group


def test_path_to_tool_group_resource_prefixes():
    assert path_to_tool_group("/api/v2/standups") == "standup"
    assert path_to_tool_group("/api/v2/standups/missing") == "standup"
    assert path_to_tool_group("/api/v2/rewards/give") == "rewards"
    assert path_to_tool_group("/api/v2/wallet") == "rewards"
    assert path_to_tool_group("/api/v2/audit-logs") == "audit"
    assert path_to_tool_group("/api/v2/webhooks/config") == "webhooks"
    assert path_to_tool_group("/api/v2/conversations") == "chat"


def test_path_to_tool_group_always_allowed_and_unmapped_none():
    # always-allowed(core) → None
    assert path_to_tool_group("/api/v2/notifications") is None
    assert path_to_tool_group("/api/v2/dashboard") is None
    assert path_to_tool_group("/api/v2/team-members") is None
    assert path_to_tool_group("/api/v2/events/pending") is None
    # 미매핑 → None(core)
    assert path_to_tool_group("/api/v2/projects") is None


def test_path_allowed_group_key():
    scope = ["read", "write", "standup"]
    assert path_allowed_for_scope("/api/v2/standups", scope) is True       # 자기 그룹
    assert path_allowed_for_scope("/api/v2/rewards/give", scope) is False   # 타 그룹 차단
    assert path_allowed_for_scope("/api/v2/notifications", scope) is True   # always-allowed


def test_path_allowed_full_key_no_regression():
    # 일반키(read/write·그룹 토큰 없음) → 전체 그룹 허용
    for path in ("/api/v2/rewards/give", "/api/v2/standups", "/api/v2/audit-logs"):
        assert path_allowed_for_scope(path, ["read", "write"]) is True
        assert path_allowed_for_scope(path, []) is True  # 빈 scope = legacy 전체


def _api_auth(scope):
    a = MagicMock()
    a.claims = {"app_metadata": {"api_key_id": "ak", "scope": scope}}
    return a


def test_check_scope_group_key_blocks_other_group():
    # standup 그룹키 → rewards 엔드포인트 직접 호출 → 403
    with pytest.raises(HTTPException) as exc:
        _check_api_key_scope(_api_auth(["read", "write", "standup"]), "POST", "/api/v2/rewards/give")
    assert exc.value.status_code == 403


def test_check_scope_group_key_allows_own_group():
    # standup 그룹키 → standup 엔드포인트 → 통과(예외 없음)
    _check_api_key_scope(_api_auth(["read", "write", "standup"]), "GET", "/api/v2/standups")


def test_check_scope_full_key_no_regression():
    # full 키 → 모든 그룹 통과
    _check_api_key_scope(_api_auth(["read", "write"]), "POST", "/api/v2/rewards/give")


def test_check_scope_always_allowed_bypass():
    # 그룹키라도 always-allowed(notifications/dashboard) → 통과
    _check_api_key_scope(_api_auth(["read", "write", "standup"]), "GET", "/api/v2/notifications")
    _check_api_key_scope(_api_auth(["read", "write", "standup"]), "GET", "/api/v2/dashboard")


def test_check_scope_jwt_skipped():
    # JWT(api_key_id 없음) → 미적용(웹 UI 무영향)
    jwt = MagicMock()
    jwt.claims = {"app_metadata": {"org_id": "o"}}
    _check_api_key_scope(jwt, "POST", "/api/v2/rewards/give")  # 예외 없음
