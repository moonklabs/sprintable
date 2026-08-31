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


def test_escalation_delivery_token_rejected_here_cross_kind_defense(monkeypatch):
    """story #3263(페드루 PO 조건①) — 위임 토큰과 에스컬 이벤트 토큰이 같은 대칭키
    (SUPPORT_GATEWAY_TOKEN_SECRET)를 공유하므로 교차 사용이 구조적으로 죽어야 한다.
    aud="backend:escalation-events"가 실린 토큰(escalation_delivery.py가 만드는 정확한 모양)을
    이 위임 토큰 검증기에 던지면 401(여기서는 DelegatedTokenError)로 거부돼야 한다.

    ⚠️실측(2026-08-31) — 방어가 2중이다: ①PyJWT가 decode()에 audience=를 안 넘겨도 토큰에
    aud 클레임이 있으면 자동으로 InvalidAudienceError를 던진다(라이브러리 기본 동작 —
    token_verify.py의 명시 aud 가드를 지워도 이 테스트는 여전히 통과함을 직접 확認).
    ②token_verify.py의 명시 `claims.get("aud") is not None` 체크(2차 방어+원인 명시).
    이 테스트는 «교차 거부가 실제로 일어나는가»라는 계약을 고정하는 것이지, 어느 층이
    막았는지는 구분하지 않는다(둘 중 하나만 살아있어도 green)."""
    token = jwt.encode(
        {
            "aud": "backend:escalation-events",
            "escalation_id": str(uuid.uuid4()),
            "org_id": str(uuid.uuid4()),
            "user_id": str(uuid.uuid4()),
            "reason": "classifier",
            "detail": "테스트",
            "conversation_summary": "테스트",
        },
        TEST_TOKEN_SECRET,
        algorithm="HS256",
    )
    with pytest.raises(DelegatedTokenError):
        verify_delegated_token(token)
