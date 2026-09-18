"""story #3263(지원v1·5에스컬레이션) — Gateway→backend 에스컬레이션 배달(escalation_delivery.py)
단위 테스트. 실 backend는 안 띄운다 — httpx.MockTransport로 outbound POST를 가로채 요청
모양(aud·claims·헤더)과 실패 처리(정직 로그+예외 미전파)만 검증한다."""
from __future__ import annotations

import uuid
from contextlib import contextmanager

import httpx
import jwt
import pytest

from app.config import settings
from app.escalation_delivery import ESCALATION_DELIVERY_AUD, deliver_escalation_event
from tests.conftest import TEST_TOKEN_SECRET


@pytest.fixture(autouse=True)
def _configure_delivery(monkeypatch):
    monkeypatch.setattr(settings, "token_secret", TEST_TOKEN_SECRET)
    monkeypatch.setattr(settings, "backend_escalation_events_url", "https://backend.test/api/v2/support/escalation-events")


@contextmanager
def _mock_backend(handler):
    """httpx.AsyncClient(...)가 내부에서 만드는 client의 transport만 갈아끼운다 — timeout 등
    나머지 kwargs는 실 코드 그대로 통과시켜 escalation_delivery.py의 실제 호출 모양을 그대로
    태운다."""
    import unittest.mock

    original_client = httpx.AsyncClient

    def fake_client(**kw):
        kw.pop("transport", None)
        return original_client(transport=httpx.MockTransport(handler), **kw)

    with unittest.mock.patch.object(httpx, "AsyncClient", fake_client):
        yield


async def test_posts_signed_token_with_escalation_delivery_aud():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("authorization", "")
        return httpx.Response(200)

    escalation_id, org_id, user_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    with _mock_backend(handler):
        ok = await deliver_escalation_event(
            escalation_id=escalation_id, org_id=org_id, user_id=user_id,
            reason="classifier", detail="인입 분류기가 사람 필요로 판정", conversation_summary="고객: 문의합니다",
        )

    assert ok is True
    assert captured["url"] == "https://backend.test/api/v2/support/escalation-events"
    assert captured["auth"].startswith("Bearer ")
    token = captured["auth"].removeprefix("Bearer ")
    claims = jwt.decode(token, TEST_TOKEN_SECRET, algorithms=["HS256"], audience=ESCALATION_DELIVERY_AUD)
    assert claims["aud"] == "backend:escalation-events"
    assert claims["escalation_id"] == str(escalation_id)
    assert claims["org_id"] == str(org_id)
    assert claims["user_id"] == str(user_id)
    assert claims["reason"] == "classifier"
    # 페드루 PO 조건② — 카드 본문에 실물이 실려야 한다("가서 보라" 스텁 금지). detail·
    # conversation_summary가 클레임 자체에 실 텍스트로 담기는지 직접 확認.
    assert claims["detail"] == "인입 분류기가 사람 필요로 판정"
    assert claims["conversation_summary"] == "고객: 문의합니다"


def test_delivery_token_ttl_shorter_than_delegated_token():
    """1회성 배달용이라 위임 토큰(backend가 발급, settings.token_ttl_seconds=300초 기본)보다
    더 짧게 — 유출 피해 창 최소화."""
    import app.escalation_delivery as mod

    assert mod._DELIVERY_TOKEN_TTL_SECONDS < settings.token_ttl_seconds


async def test_missing_backend_url_skips_without_raising(monkeypatch):
    """미설정=정직 skip. SupportEscalation 행 생성 자체를 막지 않는다는 계약의 절반(호출부
    escalation_task는 별도 테스트)."""
    monkeypatch.setattr(settings, "backend_escalation_events_url", "")
    ok = await deliver_escalation_event(
        escalation_id=uuid.uuid4(), org_id=uuid.uuid4(), user_id=uuid.uuid4(),
        reason="classifier", detail="d", conversation_summary="s",
    )
    assert ok is False


async def test_missing_token_secret_skips_without_raising(monkeypatch):
    monkeypatch.setattr(settings, "token_secret", "")
    ok = await deliver_escalation_event(
        escalation_id=uuid.uuid4(), org_id=uuid.uuid4(), user_id=uuid.uuid4(),
        reason="classifier", detail="d", conversation_summary="s",
    )
    assert ok is False


async def test_backend_non_2xx_swallowed_not_raised():
    """카디르 QA류 회귀가드 선제 반영 — 배달 실패(네트워크·비2xx)가 예외로 전파되면 handle_turn
    본문의 무보호 호출부(classifier/cost_cap/no_fiction_guard)에서 고객 응대 턴 자체가 500 난다.
    이 함수가 절대 예외를 밖으로 던지지 않는다는 계약을 직접 단언한다."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    with _mock_backend(handler):
        ok = await deliver_escalation_event(
            escalation_id=uuid.uuid4(), org_id=uuid.uuid4(), user_id=uuid.uuid4(),
            reason="classifier", detail="d", conversation_summary="s",
        )
    assert ok is False


async def test_network_error_swallowed_not_raised():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("연결 거부", request=request)

    with _mock_backend(handler):
        ok = await deliver_escalation_event(
            escalation_id=uuid.uuid4(), org_id=uuid.uuid4(), user_id=uuid.uuid4(),
            reason="classifier", detail="d", conversation_summary="s",
        )
    assert ok is False
