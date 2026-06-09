"""1d109a96: BYOA 툴그룹 scope 키 write 403 회귀 fix.

근본: _check_api_key_scope Stage 1(coarse read/write 게이팅)이 툴그룹 scope 키(예 ['stories'])에
'write' 토큰이 없다는 이유로 모든 write(POST/PUT/PATCH/DELETE)를 잘못 403했다(Isaac write 블록).
fix: Stage 1 을 레거시(read/write) scope 보유 키에만 적용. 툴그룹 키의 write 경계는 Stage 2(path
→toolset group 서버사이드 강제)가 담당한다. Stage 2 는 미변경.

전제 매핑(mcp_toolset SSOT): '/api/v2/stories'→'stories', '/api/v2/sprints'→'sprints'.
둘 다 ALL_GROUPS 소속이라 Stage 2 path boundary 가 실제로 강제된다.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from app.dependencies.auth import _check_api_key_scope
from app.services.mcp_toolset import ALL_GROUPS, path_to_tool_group


def _api_auth(scope):
    """API key AuthContext mock — app_metadata.api_key_id 세팅(API 경로 분기)."""
    a = MagicMock()
    a.claims = {"app_metadata": {"api_key_id": "ak", "scope": scope}}
    return a


def test_mapping_preconditions():
    # 테스트가 의존하는 실제 매핑(미매핑이면 Stage 2 면제라 CP2 가 안 잡힘)
    assert path_to_tool_group("/api/v2/stories") == "stories"
    assert path_to_tool_group("/api/v2/sprints") == "sprints"
    assert "stories" in ALL_GROUPS
    assert "sprints" in ALL_GROUPS


def test_cp1_toolgroup_scope_write_allowed():
    # CP1: scope=['stories']·POST·/api/v2/stories → 예외 없음(툴그룹 write 언블록·Isaac)
    _check_api_key_scope(_api_auth(["stories"]), "POST", "/api/v2/stories")


def test_cp2_toolgroup_scope_other_group_blocked():
    # CP2: scope=['stories']·POST·/api/v2/sprints(미허용 그룹) → 403(Stage 2 path boundary)
    with pytest.raises(HTTPException) as exc:
        _check_api_key_scope(_api_auth(["stories"]), "POST", "/api/v2/sprints")
    assert exc.value.status_code == 403


def test_cp3_no_scope_key_unaffected():
    # CP3: app_metadata 에 scope 키 부재 → 기본 ['read','write'] → 전체 허용(무영향)
    a = MagicMock()
    a.claims = {"app_metadata": {"api_key_id": "ak"}}  # scope 미존재
    _check_api_key_scope(a, "POST", "/api/v2/stories")  # 예외 없음
    _check_api_key_scope(a, "POST", "/api/v2/sprints")  # 예외 없음


def test_cp4_read_only_legacy_write_blocked():
    # CP4: scope=['read']·POST·임의 path → 403(read-only 보안 유지·Stage 1 레거시 적용)
    with pytest.raises(HTTPException) as exc:
        _check_api_key_scope(_api_auth(["read"]), "POST", "/api/v2/stories")
    assert exc.value.status_code == 403


def test_cp5_legacy_read_write_no_regression():
    # CP5: scope=['read','write']·POST → 예외 없음(legacy 무회귀)
    _check_api_key_scope(_api_auth(["read", "write"]), "POST", "/api/v2/stories")
    _check_api_key_scope(_api_auth(["read", "write"]), "POST", "/api/v2/sprints")


def test_read_only_legacy_get_allowed():
    # 보강: scope=['read']·GET → 통과(read-only 키의 read 는 허용)
    _check_api_key_scope(_api_auth(["read"]), "GET", "/api/v2/stories")


def test_toolgroup_scope_read_allowed_own_group():
    # 보강: scope=['stories']·GET·/api/v2/stories → 통과(자기 그룹 read)
    _check_api_key_scope(_api_auth(["stories"]), "GET", "/api/v2/stories")
