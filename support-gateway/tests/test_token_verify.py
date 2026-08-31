from __future__ import annotations

import uuid

import jwt
import pytest

from app.config import settings
from app.token_verify import DelegatedTokenError, verify_delegated_token
from tests.conftest import TEST_TOKEN_SECRET


def test_valid_token_roundtrip():
    org_id, user_id = uuid.uuid4(), uuid.uuid4()
    token = jwt.encode({"org_id": str(org_id), "user_id": str(user_id)}, TEST_TOKEN_SECRET, algorithm="HS256")
    identity = verify_delegated_token(token)
    assert identity.org_id == org_id
    assert identity.user_id == user_id


def test_wrong_secret_rejected():
    token = jwt.encode(
        {"org_id": str(uuid.uuid4()), "user_id": str(uuid.uuid4())}, "wrong-secret", algorithm="HS256"
    )
    with pytest.raises(DelegatedTokenError):
        verify_delegated_token(token)


def test_missing_claims_rejected():
    token = jwt.encode({"org_id": str(uuid.uuid4())}, TEST_TOKEN_SECRET, algorithm="HS256")
    with pytest.raises(DelegatedTokenError):
        verify_delegated_token(token)


def test_malformed_uuid_claim_rejected():
    token = jwt.encode({"org_id": "not-a-uuid", "user_id": str(uuid.uuid4())}, TEST_TOKEN_SECRET, algorithm="HS256")
    with pytest.raises(DelegatedTokenError):
        verify_delegated_token(token)


def test_unconfigured_secret_fails_closed(monkeypatch):
    """시크릿 미설정=전부 거부(fail-closed) — fail-open이면 검증 자체가 무의미해진다."""
    monkeypatch.setattr(settings, "token_secret", "")
    token = jwt.encode(
        {"org_id": str(uuid.uuid4()), "user_id": str(uuid.uuid4())}, TEST_TOKEN_SECRET, algorithm="HS256"
    )
    with pytest.raises(DelegatedTokenError):
        verify_delegated_token(token)
