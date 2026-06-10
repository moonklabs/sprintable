"""fc7bce47: Supabase 잔재 제거 — JWT secret 단일화(jwt_secret) 토큰 호환 가드.

supabase_jwt_secret 폴백 + supabase_url/effective_jwt_secret 제거. dev/prod JWT_SECRET 세팅
확인됨(PO gcloud) → jwt_secret 단일로 발급↔검증 round-trip 동일 secret = 기존 토큰 호환(로그아웃 0).
"""
from __future__ import annotations

import uuid

from app.core.config import Settings


def test_settings_has_no_supabase_fields():
    """config 에서 supabase_* 필드·effective_jwt_secret 완전 제거."""
    s = Settings()
    assert not hasattr(s, "supabase_jwt_secret")
    assert not hasattr(s, "supabase_url")
    assert not hasattr(s, "effective_jwt_secret")


def test_get_secret_uses_jwt_secret_only(monkeypatch):
    """_get_secret() = jwt_secret 단일(supabase 폴백 없음)."""
    from app.core import security

    monkeypatch.setattr(security.settings, "jwt_secret", "known-secret-at-least-32-chars-long")
    assert security._get_secret() == "known-secret-at-least-32-chars-long"


def test_token_round_trip_jwt_secret_only(monkeypatch):
    """jwt_secret 단일로 발급한 토큰이 동일 secret 로 검증됨(기존 토큰 호환·로그아웃 0)."""
    from app.core import security

    monkeypatch.setattr(security.settings, "jwt_secret", "roundtrip-secret-at-least-32-chars")
    sub = str(uuid.uuid4())
    token = security.create_access_token(sub, {"org_id": "o"})
    decoded = security.decode_jwt(token)
    assert decoded.get("sub") == sub
