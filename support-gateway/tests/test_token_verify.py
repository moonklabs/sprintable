from __future__ import annotations

import uuid

import jwt
import pytest

from app.config import settings
from app.token_verify import (
    ESCALATION_RESOLUTION_AUD,
    OPERATOR_REPLY_AUD,
    DelegatedTokenError,
    EscalationResolutionTokenError,
    OperatorReplyTokenError,
    verify_delegated_token,
    verify_escalation_resolution_token,
    verify_operator_reply_token,
)
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


# --- story #3279 — 운영자 회신 토큰(backend→gateway, escalation_delivery.py 반대 방향) -----


def test_operator_reply_token_valid_roundtrip():
    escalation_id = uuid.uuid4()
    token = jwt.encode(
        {"aud": OPERATOR_REPLY_AUD, "escalation_id": str(escalation_id), "content": "확인했습니다, 답변드릴게요."},
        TEST_TOKEN_SECRET,
        algorithm="HS256",
    )
    claims = verify_operator_reply_token(token)
    assert claims.escalation_id == escalation_id
    assert claims.content == "확인했습니다, 답변드릴게요."


def test_operator_reply_token_missing_aud_rejected():
    """페드루 PO 지시(2026-09-01, story #3661 클래스 재발 방지) — aud 클레임 자체가 없는
    토큰은 반드시 거부돼야 한다(부재를 "검증 대상 없음=통과"로 오판하면 안 된다)."""
    token = jwt.encode(
        {"escalation_id": str(uuid.uuid4()), "content": "aud 없이 서명된 토큰"},
        TEST_TOKEN_SECRET,
        algorithm="HS256",
    )
    with pytest.raises(OperatorReplyTokenError):
        verify_operator_reply_token(token)


def test_operator_reply_token_wrong_aud_rejected():
    """aud가 있지만 다른 값(예: 위임 토큰·에스컬레이션 배달 토큰과 교차 오용)이면 거부."""
    token = jwt.encode(
        {"aud": "backend:escalation-events", "escalation_id": str(uuid.uuid4()), "content": "잘못된 aud"},
        TEST_TOKEN_SECRET,
        algorithm="HS256",
    )
    with pytest.raises(OperatorReplyTokenError):
        verify_operator_reply_token(token)


def test_operator_reply_token_delegated_token_rejected_here_cross_kind_defense():
    """위임 토큰(aud 없음)을 이 검증기에 잘못 던져도 거부돼야 한다."""
    token = jwt.encode(
        {"org_id": str(uuid.uuid4()), "user_id": str(uuid.uuid4())}, TEST_TOKEN_SECRET, algorithm="HS256"
    )
    with pytest.raises(OperatorReplyTokenError):
        verify_operator_reply_token(token)


def test_operator_reply_token_missing_content_rejected():
    token = jwt.encode(
        {"aud": OPERATOR_REPLY_AUD, "escalation_id": str(uuid.uuid4())}, TEST_TOKEN_SECRET, algorithm="HS256"
    )
    with pytest.raises(OperatorReplyTokenError):
        verify_operator_reply_token(token)


def test_operator_reply_token_empty_content_rejected():
    token = jwt.encode(
        {"aud": OPERATOR_REPLY_AUD, "escalation_id": str(uuid.uuid4()), "content": "   "},
        TEST_TOKEN_SECRET,
        algorithm="HS256",
    )
    with pytest.raises(OperatorReplyTokenError):
        verify_operator_reply_token(token)


def test_operator_reply_token_unconfigured_secret_fails_closed(monkeypatch):
    monkeypatch.setattr(settings, "token_secret", "")
    token = jwt.encode(
        {"aud": OPERATOR_REPLY_AUD, "escalation_id": str(uuid.uuid4()), "content": "x"},
        TEST_TOKEN_SECRET,
        algorithm="HS256",
    )
    with pytest.raises(OperatorReplyTokenError):
        verify_operator_reply_token(token)


# --- story #183fe7a5 — 에스컬레이션 해소 동기화 토큰(backend→gateway, escalation_delivery.py
# 반대 방향, operator-reply와 같은 방향·다른 aud) -------------------------------------------


def test_escalation_resolution_token_valid_roundtrip():
    escalation_id = uuid.uuid4()
    token = jwt.encode(
        {"aud": ESCALATION_RESOLUTION_AUD, "escalation_id": str(escalation_id), "resolution": "approved"},
        TEST_TOKEN_SECRET,
        algorithm="HS256",
    )
    claims = verify_escalation_resolution_token(token)
    assert claims.escalation_id == escalation_id
    assert claims.resolution == "approved"


def test_escalation_resolution_token_missing_aud_rejected():
    token = jwt.encode(
        {"escalation_id": str(uuid.uuid4()), "resolution": "approved"}, TEST_TOKEN_SECRET, algorithm="HS256"
    )
    with pytest.raises(EscalationResolutionTokenError):
        verify_escalation_resolution_token(token)


def test_escalation_resolution_token_wrong_aud_rejected():
    """교차토큰 방어 — operator-reply aud가 실린 토큰을 이 검증기에 던지면 거부."""
    token = jwt.encode(
        {"aud": OPERATOR_REPLY_AUD, "escalation_id": str(uuid.uuid4()), "resolution": "approved"},
        TEST_TOKEN_SECRET,
        algorithm="HS256",
    )
    with pytest.raises(EscalationResolutionTokenError):
        verify_escalation_resolution_token(token)


def test_escalation_resolution_token_delegated_token_rejected_here_cross_kind_defense():
    """위임 토큰(aud 없음)을 이 검증기에 잘못 던져도 거부돼야 한다."""
    token = jwt.encode(
        {"org_id": str(uuid.uuid4()), "user_id": str(uuid.uuid4())}, TEST_TOKEN_SECRET, algorithm="HS256"
    )
    with pytest.raises(EscalationResolutionTokenError):
        verify_escalation_resolution_token(token)


def test_operator_reply_token_rejected_by_escalation_resolution_verifier_cross_kind_defense():
    """반대 방향 교차 — operator-reply 검증기가 이 토큰을 받아도 안 되고(위에서 확인),
    이 검증기가 operator-reply 토큰을 받아도 안 된다(양방향 pin)."""
    token = jwt.encode(
        {"aud": ESCALATION_RESOLUTION_AUD, "escalation_id": str(uuid.uuid4()), "resolution": "rejected"},
        TEST_TOKEN_SECRET,
        algorithm="HS256",
    )
    with pytest.raises(OperatorReplyTokenError):
        verify_operator_reply_token(token)


def test_escalation_resolution_token_missing_resolution_rejected():
    token = jwt.encode(
        {"aud": ESCALATION_RESOLUTION_AUD, "escalation_id": str(uuid.uuid4())}, TEST_TOKEN_SECRET, algorithm="HS256"
    )
    with pytest.raises(EscalationResolutionTokenError):
        verify_escalation_resolution_token(token)


def test_escalation_resolution_token_empty_resolution_rejected():
    token = jwt.encode(
        {"aud": ESCALATION_RESOLUTION_AUD, "escalation_id": str(uuid.uuid4()), "resolution": "   "},
        TEST_TOKEN_SECRET,
        algorithm="HS256",
    )
    with pytest.raises(EscalationResolutionTokenError):
        verify_escalation_resolution_token(token)


def test_escalation_resolution_token_unconfigured_secret_fails_closed(monkeypatch):
    monkeypatch.setattr(settings, "token_secret", "")
    token = jwt.encode(
        {"aud": ESCALATION_RESOLUTION_AUD, "escalation_id": str(uuid.uuid4()), "resolution": "approved"},
        TEST_TOKEN_SECRET,
        algorithm="HS256",
    )
    with pytest.raises(EscalationResolutionTokenError):
        verify_escalation_resolution_token(token)
