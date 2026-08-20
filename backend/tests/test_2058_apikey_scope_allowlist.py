"""story #2058 AC4: `CreateApiKeyRequest.scope` 허용 목록 검증.

이전엔 `POST /agents/{id}/api-keys`가 scope를 무검증 저장했다(오타/garbage도 그대로 DB에
들어간 뒤 `path_allowed_for_scope`에서 전부 거부되는 형태로만 드러났다 — fail-closed라 악용
벡터는 아니었지만 UX/디버깅 결함). `mcp_toolset.ALL_GROUPS`(agent_recruiter.validate_tool_groups와
동일 SSOT) ∪ 레거시 `read`/`write`만 허용한다.

⚠️ CREATE 시점 검증만(스키마 레벨) — 기존 발급 키/rotate는 무영향(별도로 재검증하지 않음).

story #2838 후속 — `expires_at`이 이제 필수 필드(기본값 제거)라 이 파일의 모든 인스턴스화에
`expires_at=None`을 명시(이 파일의 관심사는 scope 검증이지 만료 검증이 아니므로 무해한 값)."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas.api_key import CreateApiKeyRequest
from app.services.mcp_toolset import ALL_GROUPS, _LEGACY_SCOPES


def test_none_scope_passes():
    req = CreateApiKeyRequest(scope=None, expires_at=None)
    assert req.scope is None


def test_legacy_read_write_scope_passes():
    req = CreateApiKeyRequest(scope=["read", "write"], expires_at=None)
    assert req.scope == ["read", "write"]


@pytest.mark.parametrize("group", list(ALL_GROUPS))
def test_every_known_toolgroup_passes(group):
    req = CreateApiKeyRequest(scope=[group], expires_at=None)
    assert req.scope == [group]


def test_unknown_token_rejected():
    with pytest.raises(ValidationError, match="unknown token"):
        CreateApiKeyRequest(scope=["not_a_real_group"], expires_at=None)


def test_admin_group_rejected_not_grantable():
    """"admin"은 ALL_GROUPS에서 의도적으로 제외돼 있다(mcp_toolset.py:103) — scope로 부여 불가."""
    assert "admin" not in ALL_GROUPS
    with pytest.raises(ValidationError, match="unknown token"):
        CreateApiKeyRequest(scope=["admin"], expires_at=None)


def test_mixed_valid_and_invalid_rejects_whole_list():
    with pytest.raises(ValidationError, match="unknown token"):
        CreateApiKeyRequest(scope=["stories", "bogus"], expires_at=None)


def test_allowed_set_is_groups_union_legacy():
    allowed = set(ALL_GROUPS) | _LEGACY_SCOPES
    req = CreateApiKeyRequest(scope=sorted(allowed), expires_at=None)
    assert set(req.scope) == allowed
