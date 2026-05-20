"""E-ENTITY-CLEANUP S9: Org 생성 validation + org-members user name JOIN 테스트.

BUG-2: 빈 name/slug → 400 (기존: 409)
BUG-4: GET /api/v2/org-members → email 포함
"""
from __future__ import annotations

import inspect
import pytest


# ─── BUG-2: name/slug validation ──────────────────────────────────────────────

def test_create_org_empty_name_raises_validation():
    """CreateOrganization name='' → ValidationError."""
    from pydantic import ValidationError
    from app.schemas.organization import CreateOrganization
    with pytest.raises(ValidationError) as exc_info:
        CreateOrganization(name="", slug="valid-slug")
    assert "empty" in str(exc_info.value).lower() or "name" in str(exc_info.value).lower()


def test_create_org_whitespace_name_raises_validation():
    """CreateOrganization name='  ' → ValidationError."""
    from pydantic import ValidationError
    from app.schemas.organization import CreateOrganization
    with pytest.raises(ValidationError):
        CreateOrganization(name="   ", slug="valid-slug")


def test_create_org_empty_slug_raises_validation():
    """CreateOrganization slug='' → ValidationError."""
    from pydantic import ValidationError
    from app.schemas.organization import CreateOrganization
    with pytest.raises(ValidationError):
        CreateOrganization(name="Valid Name", slug="")


def test_create_org_whitespace_slug_raises_validation():
    """CreateOrganization slug='  ' → ValidationError."""
    from pydantic import ValidationError
    from app.schemas.organization import CreateOrganization
    with pytest.raises(ValidationError):
        CreateOrganization(name="Valid Name", slug="   ")


def test_create_org_valid_strips_whitespace():
    """CreateOrganization name/slug 공백 strip 후 유효."""
    from app.schemas.organization import CreateOrganization
    obj = CreateOrganization(name="  My Org  ", slug="  my-org  ")
    assert obj.name == "My Org"
    assert obj.slug == "my-org"


def test_create_org_valid_passes():
    """CreateOrganization 정상 입력 → 통과."""
    from app.schemas.organization import CreateOrganization
    obj = CreateOrganization(name="My Org", slug="my-org")
    assert obj.name == "My Org"
    assert obj.slug == "my-org"


# ─── BUG-4: org-members email JOIN ────────────────────────────────────────────

def test_org_member_response_has_email_field():
    """OrgMemberResponse 스키마에 email 필드 존재."""
    from app.schemas.org_member import OrgMemberResponse
    assert "email" in OrgMemberResponse.model_fields


def test_org_member_response_email_optional():
    """OrgMemberResponse.email은 Optional (None 허용)."""
    from app.schemas.org_member import OrgMemberResponse
    field = OrgMemberResponse.model_fields["email"]
    # is_required=False or default=None
    assert not field.is_required() or field.default is None


def test_list_org_members_uses_join():
    """list_org_members 소스에 users JOIN 쿼리 존재."""
    from app.routers import org_members
    source = inspect.getsource(org_members.list_org_members)
    assert "users" in source
    assert "email" in source
    assert "JOIN" in source or "join" in source.lower()


def test_list_org_members_filters_deleted():
    """list_org_members 소스에 deleted_at IS NULL 필터 존재."""
    from app.routers import org_members
    source = inspect.getsource(org_members.list_org_members)
    assert "deleted_at" in source
    assert "NULL" in source or "null" in source.lower()


# ─── BUG-1: GET /api/v2/organizations/{id} 엔드포인트 ────────────────────────

def test_get_organization_endpoint_exists():
    """GET /{id} 엔드포인트 존재."""
    from app.routers import organizations
    methods_paths = [(list(r.methods or []), r.path) for r in organizations.router.routes]
    has_get_by_id = any(
        "GET" in m and "{id}" in p and "impact" not in p
        for m, p in methods_paths
    )
    assert has_get_by_id


def test_get_organization_checks_membership():
    """get_organization 소스에 membership 확인 로직 존재."""
    from app.routers import organizations
    source = inspect.getsource(organizations.get_organization)
    assert "get_member_role" in source
    assert "404" in source
