"""story #3259(지원v1·1경계) — POST /api/v2/support/session-token. 이 엔드포인트가 발급하는
클레임이 {org_id, user_id, exp, iat}로 딱 고정돼 있는지, 시크릿 미설정 시 fail-closed(503)인지만
검증한다 — support-gateway 쪽 검증 로직은 support-gateway/tests/에서 별도로 검증한다(물리
분리 서비스라 이 backend 테스트 스위트에서 그쪽을 import하지 않는다)."""
from __future__ import annotations

import uuid

import pytest
from jose import jwt as jose_jwt


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def _client(*, org_id: str | None, secret: str, monkeypatch):
    from app.core.config import settings
    from app.dependencies.auth import AuthContext, get_current_user
    from app.main import app

    monkeypatch.setattr(settings, "support_gateway_token_secret", secret)

    ctx = AuthContext(user_id=str(uuid.uuid4()), email=None, claims={}, org_id=org_id)

    async def override_auth():
        return ctx

    app.dependency_overrides[get_current_user] = override_auth
    from httpx import ASGITransport, AsyncClient

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.anyio
async def test_issues_token_with_exactly_expected_claims(monkeypatch):
    org_id = str(uuid.uuid4())
    secret = "test-secret-padded-to-32-bytes-min"
    async with await _client(org_id=org_id, secret=secret, monkeypatch=monkeypatch) as ac:
        resp = await ac.post("/api/v2/support/session-token")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    claims = jose_jwt.decode(body["token"], secret, algorithms=["HS256"])
    assert set(claims.keys()) == {"org_id", "user_id", "exp", "iat"}
    assert claims["org_id"] == org_id
    from app.main import app
    app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_missing_secret_fails_closed(monkeypatch):
    async with await _client(org_id=str(uuid.uuid4()), secret="", monkeypatch=monkeypatch) as ac:
        resp = await ac.post("/api/v2/support/session-token")
    assert resp.status_code == 503
    from app.main import app
    app.dependency_overrides.clear()


@pytest.mark.anyio
async def test_no_org_context_rejected(monkeypatch):
    async with await _client(org_id=None, secret="test-secret-padded-to-32-bytes-min", monkeypatch=monkeypatch) as ac:
        resp = await ac.post("/api/v2/support/session-token")
    assert resp.status_code == 400
    from app.main import app
    app.dependency_overrides.clear()


# story #3263(지원v1·5에스컬레이션, 페드루 PO 조건①) — session-token 발급(위임 토큰, aud
# 없음)과 escalation-events 검증(에스컬 배달 토큰, aud="backend:escalation-events") 두 종이
# 같은 대칭키를 공유한다. 교차 사용은 구조적으로 죽어야 한다 — 이 파일은 위임 토큰이
# escalation 검증기로 잘못 흘러들어온 방향(반대 방향은 support-gateway/tests/test_token_
# verify.py가 대칭으로 커버)을 고정한다.
def test_delegated_session_token_rejected_by_escalation_delivery_verifier():
    from app.routers.support_gateway_token import EscalationDeliveryError, verify_escalation_delivery_token
    from app.core.config import settings

    secret = "test-secret-padded-to-32-bytes-min"
    settings_backup = settings.support_gateway_token_secret
    settings.support_gateway_token_secret = secret
    try:
        # session-token.py가 실제로 발급하는 정확한 모양(aud 클레임 없음, 4개뿐).
        delegated_token = jose_jwt.encode(
            {"org_id": str(uuid.uuid4()), "user_id": str(uuid.uuid4())}, secret, algorithm="HS256",
        )
        with pytest.raises(EscalationDeliveryError):
            verify_escalation_delivery_token(delegated_token)
    finally:
        settings.support_gateway_token_secret = settings_backup


# story #3263 2차(카디르 QA 격리테스트, 2026-08-31) — jose는 **토큰에 aud 클레임이 아예
# 없으면** decode()의 audience= 인자를 조용히 건너뛴다(불일치 거부가 아니라 "비교할 대상이
# 없으니 통과"). 위 test_delegated_session_token_rejected_by_escalation_delivery_verifier가
# 통과하는 건 위임 토큰이 escalation_id 등 필드도 없어 우연히 KeyError로 걸리는 것뿐 —
# aud 클레임 부재 자체를 겨냥해 거부하는지는 그 테스트로 증명이 안 된다. 이 테스트는
# escalation 토큰의 **다른 모든 필드는 정확한 채로 aud만 빠뜨린** 케이스를 직접 겨냥한다
# (필드 모양이 우연히 다른 경우를 배제 — aud 부재 자체가 거부 사유임을 고립 증명).
def test_escalation_shaped_token_without_aud_claim_is_rejected_not_silently_accepted():
    from app.routers.support_gateway_token import EscalationDeliveryError, verify_escalation_delivery_token
    from app.core.config import settings

    secret = "test-secret-padded-to-32-bytes-min"
    settings_backup = settings.support_gateway_token_secret
    settings.support_gateway_token_secret = secret
    try:
        # aud만 빼고 나머지 필드는 정확한 escalation 배달 토큰 모양 그대로.
        no_aud_token = jose_jwt.encode(
            {
                "escalation_id": str(uuid.uuid4()), "org_id": str(uuid.uuid4()), "user_id": str(uuid.uuid4()),
                "reason": "classifier", "detail": "d", "conversation_summary": "s",
            },
            secret,
            algorithm="HS256",
        )
        with pytest.raises(EscalationDeliveryError):
            verify_escalation_delivery_token(no_aud_token)
    finally:
        settings.support_gateway_token_secret = settings_backup


def test_escalation_delivery_token_with_correct_aud_verifies_and_returns_claims():
    from app.routers.support_gateway_token import verify_escalation_delivery_token, ESCALATION_DELIVERY_AUD
    from app.core.config import settings

    secret = "test-secret-padded-to-32-bytes-min"
    settings_backup = settings.support_gateway_token_secret
    settings.support_gateway_token_secret = secret
    try:
        escalation_id, org_id, user_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        token = jose_jwt.encode(
            {
                "aud": ESCALATION_DELIVERY_AUD,
                "escalation_id": str(escalation_id),
                "org_id": str(org_id),
                "user_id": str(user_id),
                "reason": "classifier",
                "detail": "인입 분류기가 사람 필요로 판정",
                "conversation_summary": "고객: 문의합니다",
            },
            secret,
            algorithm="HS256",
        )
        claims = verify_escalation_delivery_token(token)
        assert claims.escalation_id == escalation_id
        assert claims.org_id == org_id
        assert claims.user_id == user_id
        assert claims.reason == "classifier"
        assert claims.detail == "인입 분류기가 사람 필요로 판정"
        assert claims.conversation_summary == "고객: 문의합니다"
    finally:
        settings.support_gateway_token_secret = settings_backup


def test_escalation_delivery_verifier_fails_closed_when_secret_unconfigured():
    from app.routers.support_gateway_token import (
        EscalationDeliveryError, ESCALATION_DELIVERY_AUD, verify_escalation_delivery_token,
    )
    from app.core.config import settings

    settings_backup = settings.support_gateway_token_secret
    settings.support_gateway_token_secret = ""
    try:
        token = jose_jwt.encode(
            {
                "aud": ESCALATION_DELIVERY_AUD, "escalation_id": str(uuid.uuid4()), "org_id": str(uuid.uuid4()),
                "user_id": str(uuid.uuid4()), "reason": "classifier", "detail": "d", "conversation_summary": "s",
            },
            "some-other-secret-padded-to-32-bytes",
            algorithm="HS256",
        )
        with pytest.raises(EscalationDeliveryError):
            verify_escalation_delivery_token(token)
    finally:
        settings.support_gateway_token_secret = settings_backup


# story #3263(지원v1·5에스컬레이션) AC1/AC2 — POST /api/v2/support/escalation-events. 이
# 섹션은 DB에 닿기 전에 끝나는 fail-closed 분기만 커버(requester/approver 미설정) — 실 게이트
# 생성(org/project 해소+create_gate+카드배달)은 real PG 필요라 test_3263_support_escalation_
# events_realdb.py(별도 파일, PARITY/ALEMBIC_DATABASE_URL 게이트)에서 검증한다.
async def _escalation_client(*, secret: str, requester_id: str, approver_id: str, monkeypatch):
    from app.core.config import settings
    from app.main import app

    monkeypatch.setattr(settings, "support_gateway_token_secret", secret)
    monkeypatch.setattr(settings, "support_escalation_requester_member_id", requester_id)
    monkeypatch.setattr(settings, "support_escalation_approver_member_id", approver_id)

    from httpx import ASGITransport, AsyncClient
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _make_escalation_token(secret: str) -> str:
    from app.routers.support_gateway_token import ESCALATION_DELIVERY_AUD

    return jose_jwt.encode(
        {
            "aud": ESCALATION_DELIVERY_AUD,
            "escalation_id": str(uuid.uuid4()),
            "org_id": str(uuid.uuid4()),
            "user_id": str(uuid.uuid4()),
            "reason": "classifier",
            "detail": "인입 분류기가 사람 필요로 판정",
            "conversation_summary": "고객: 문의합니다",
        },
        secret,
        algorithm="HS256",
    )


@pytest.mark.anyio
async def test_escalation_events_fails_closed_when_requester_not_configured(monkeypatch):
    secret = "test-secret-padded-to-32-bytes-min"
    async with await _escalation_client(secret=secret, requester_id="", approver_id=str(uuid.uuid4()), monkeypatch=monkeypatch) as ac:
        resp = await ac.post(
            "/api/v2/support/escalation-events",
            headers={"Authorization": f"Bearer {_make_escalation_token(secret)}"},
        )
    assert resp.status_code == 503


@pytest.mark.anyio
async def test_escalation_events_fails_closed_when_approver_not_configured(monkeypatch):
    secret = "test-secret-padded-to-32-bytes-min"
    async with await _escalation_client(secret=secret, requester_id=str(uuid.uuid4()), approver_id="", monkeypatch=monkeypatch) as ac:
        resp = await ac.post(
            "/api/v2/support/escalation-events",
            headers={"Authorization": f"Bearer {_make_escalation_token(secret)}"},
        )
    assert resp.status_code == 503


@pytest.mark.anyio
async def test_escalation_events_rejects_missing_bearer_token(monkeypatch):
    secret = "test-secret-padded-to-32-bytes-min"
    async with await _escalation_client(secret=secret, requester_id=str(uuid.uuid4()), approver_id=str(uuid.uuid4()), monkeypatch=monkeypatch) as ac:
        resp = await ac.post("/api/v2/support/escalation-events")
    assert resp.status_code == 401


@pytest.mark.anyio
async def test_escalation_events_rejects_delegated_session_token_not_escalation_token(monkeypatch):
    """페드루 PO 조건① — 위임 토큰(aud 없음)을 이 엔드포인트에 던지면 401."""
    secret = "test-secret-padded-to-32-bytes-min"
    delegated_token = jose_jwt.encode(
        {"org_id": str(uuid.uuid4()), "user_id": str(uuid.uuid4())}, secret, algorithm="HS256",
    )
    async with await _escalation_client(secret=secret, requester_id=str(uuid.uuid4()), approver_id=str(uuid.uuid4()), monkeypatch=monkeypatch) as ac:
        resp = await ac.post(
            "/api/v2/support/escalation-events",
            headers={"Authorization": f"Bearer {delegated_token}"},
        )
    assert resp.status_code == 401
