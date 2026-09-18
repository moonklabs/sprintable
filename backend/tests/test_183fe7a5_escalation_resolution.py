"""story #183fe7a5(지원v1·후속) — 게이트 해소(approve/reject) → gateway
SupportEscalation.status 동기화. 두 층:
①`deliver_escalation_resolution_for_gate` — 순수 Gate 객체 역참조(DB 조회 없음 — 호출부
  gate_service.py가 이미 검증된 Gate를 넘긴다, operator_reply_delivery.py와의 설계 차이는
  모듈 docstring 참고).
②`deliver_escalation_resolution` — httpx mock(story #3279 test_3279_operator_reply.py와
  동형 관례, `patch("httpx.AsyncClient.post", ...)`)."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest

from app.models.gate import Gate

# --- ① deliver_escalation_resolution_for_gate — Gate 역참조(DB 0) ------------------------


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _gate(*, work_item_type="support_escalation", escalation_id: uuid.UUID | None = None) -> Gate:
    gate_id = uuid.uuid4()
    neutral_facts = {"support_escalation_id": str(escalation_id)} if escalation_id is not None else {}
    return Gate(
        id=gate_id, org_id=uuid.uuid4(), work_item_id=gate_id,
        work_item_type=work_item_type, gate_type="support_escalation_review",
        status="approved", neutral_facts=neutral_facts,
    )


@pytest.mark.anyio
async def test_delegates_with_resolved_escalation_id(monkeypatch):
    from app.services import escalation_resolution_delivery as mod

    escalation_id = uuid.uuid4()
    gate = _gate(escalation_id=escalation_id)
    delegate = AsyncMock(return_value=True)
    monkeypatch.setattr(mod, "deliver_escalation_resolution", delegate)

    result = await mod.deliver_escalation_resolution_for_gate(gate=gate, new_status="approved")

    assert result is True
    delegate.assert_awaited_once_with(escalation_id=escalation_id, resolution="approved")


@pytest.mark.anyio
async def test_reject_also_delegates_pin(monkeypatch):
    """⭐AC2 pin — reject도 approve와 동일하게 배달한다(모듈 docstring 설계 결정: gateway
    쪽 상태는 둘 다 'resolved'). resolution 값 자체는 실제 'rejected'를 정직하게 실어
    보낸다(gateway가 세분화하고 싶어지면 못 하게 막지 않는다)."""
    from app.services import escalation_resolution_delivery as mod

    escalation_id = uuid.uuid4()
    gate = _gate(escalation_id=escalation_id)
    delegate = AsyncMock(return_value=True)
    monkeypatch.setattr(mod, "deliver_escalation_resolution", delegate)

    result = await mod.deliver_escalation_resolution_for_gate(gate=gate, new_status="rejected")

    assert result is True
    delegate.assert_awaited_once_with(escalation_id=escalation_id, resolution="rejected")


@pytest.mark.anyio
async def test_non_support_escalation_gate_skips(monkeypatch):
    """오배달 방지 pin — work_item_type이 다르면(예: doc 결재) gate_id가 우연히 맞아도
    절대 배달하면 안 된다."""
    from app.services import escalation_resolution_delivery as mod

    gate = _gate(work_item_type="doc", escalation_id=uuid.uuid4())
    delegate = AsyncMock(return_value=True)
    monkeypatch.setattr(mod, "deliver_escalation_resolution", delegate)

    result = await mod.deliver_escalation_resolution_for_gate(gate=gate, new_status="approved")

    assert result is False
    delegate.assert_not_awaited()


@pytest.mark.anyio
async def test_missing_escalation_id_skips(monkeypatch):
    from app.services import escalation_resolution_delivery as mod

    gate = _gate(escalation_id=None)
    delegate = AsyncMock(return_value=True)
    monkeypatch.setattr(mod, "deliver_escalation_resolution", delegate)

    result = await mod.deliver_escalation_resolution_for_gate(gate=gate, new_status="approved")

    assert result is False
    delegate.assert_not_awaited()


@pytest.mark.anyio
async def test_malformed_escalation_id_skips(monkeypatch):
    from app.services import escalation_resolution_delivery as mod

    gate_id = uuid.uuid4()
    gate = Gate(
        id=gate_id, org_id=uuid.uuid4(), work_item_id=gate_id,
        work_item_type="support_escalation", gate_type="support_escalation_review",
        status="approved", neutral_facts={"support_escalation_id": "not-a-uuid"},
    )
    delegate = AsyncMock(return_value=True)
    monkeypatch.setattr(mod, "deliver_escalation_resolution", delegate)

    result = await mod.deliver_escalation_resolution_for_gate(gate=gate, new_status="approved")

    assert result is False
    delegate.assert_not_awaited()


# --- ② deliver_escalation_resolution — httpx mock ------------------------------------------


def _resp(status_code: int):
    class R:
        def raise_for_status(self):
            if status_code >= 400:
                import httpx
                raise httpx.HTTPStatusError("boom", request=None, response=self)  # type: ignore[arg-type]
    r = R()
    r.status_code = status_code
    return r


@pytest.mark.anyio
async def test_deliver_escalation_resolution_success(monkeypatch):
    from app.core.config import settings
    from app.services.escalation_resolution_delivery import ESCALATION_RESOLUTION_AUD, deliver_escalation_resolution

    monkeypatch.setattr(settings, "support_gateway_token_secret", "test-secret-padded-to-32-bytes-min")
    monkeypatch.setattr(
        settings, "support_gateway_escalation_resolution_url",
        "https://gateway.example/api/v1/internal/escalation-resolution",
    )

    captured = {}

    async def _post(self, url, headers=None, **kwargs):
        captured["url"] = url
        captured["headers"] = headers
        return _resp(200)

    escalation_id = uuid.uuid4()
    with patch("httpx.AsyncClient.post", new=_post):
        ok = await deliver_escalation_resolution(escalation_id=escalation_id, resolution="approved")

    assert ok is True
    assert captured["url"] == "https://gateway.example/api/v1/internal/escalation-resolution"

    from jose import jwt as jose_jwt
    claims = jose_jwt.get_unverified_claims(captured["headers"]["Authorization"].removeprefix("Bearer "))
    assert claims["aud"] == ESCALATION_RESOLUTION_AUD
    assert claims["escalation_id"] == str(escalation_id)
    assert claims["resolution"] == "approved"


@pytest.mark.anyio
async def test_deliver_escalation_resolution_5xx_returns_false_not_raises(monkeypatch):
    from app.core.config import settings
    from app.services.escalation_resolution_delivery import deliver_escalation_resolution

    monkeypatch.setattr(settings, "support_gateway_token_secret", "test-secret-padded-to-32-bytes-min")
    monkeypatch.setattr(settings, "support_gateway_escalation_resolution_url", "https://gateway.example/x")

    with patch("httpx.AsyncClient.post", new=AsyncMock(return_value=_resp(500))):
        ok = await deliver_escalation_resolution(escalation_id=uuid.uuid4(), resolution="approved")
    assert ok is False


@pytest.mark.anyio
async def test_deliver_escalation_resolution_network_error_returns_false_not_raises(monkeypatch):
    from app.core.config import settings
    from app.services.escalation_resolution_delivery import deliver_escalation_resolution

    monkeypatch.setattr(settings, "support_gateway_token_secret", "test-secret-padded-to-32-bytes-min")
    monkeypatch.setattr(settings, "support_gateway_escalation_resolution_url", "https://gateway.example/x")

    async def _post(self, url, headers=None, **kwargs):
        raise ConnectionError("network down")

    with patch("httpx.AsyncClient.post", new=_post):
        ok = await deliver_escalation_resolution(escalation_id=uuid.uuid4(), resolution="rejected")
    assert ok is False


@pytest.mark.anyio
async def test_deliver_escalation_resolution_skips_when_secret_unconfigured(monkeypatch):
    from app.core.config import settings
    from app.services.escalation_resolution_delivery import deliver_escalation_resolution

    monkeypatch.setattr(settings, "support_gateway_token_secret", "")
    monkeypatch.setattr(settings, "support_gateway_escalation_resolution_url", "https://gateway.example/x")
    ok = await deliver_escalation_resolution(escalation_id=uuid.uuid4(), resolution="approved")
    assert ok is False


@pytest.mark.anyio
async def test_deliver_escalation_resolution_skips_when_url_unconfigured(monkeypatch):
    from app.core.config import settings
    from app.services.escalation_resolution_delivery import deliver_escalation_resolution

    monkeypatch.setattr(settings, "support_gateway_token_secret", "test-secret-padded-to-32-bytes-min")
    monkeypatch.setattr(settings, "support_gateway_escalation_resolution_url", "")
    ok = await deliver_escalation_resolution(escalation_id=uuid.uuid4(), resolution="approved")
    assert ok is False
