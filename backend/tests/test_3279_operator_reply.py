"""story #3279(지원v1·후속) — 운영자 회신 배달. 세 층을 각각 겨냥한다:
①`_operator_reply_target_gate_id`(conversations.py) — 순수 함수, DB/HTTP 0.
②`deliver_operator_reply`(operator_reply_delivery.py) — httpx mock, DB 0(story #2813
  github_checks_api 관례와 동형 — `patch("httpx.AsyncClient.post", ...)`).
③`deliver_operator_reply_for_gate` — 실 PG Gate 행 조회(story #3263 realdb 관례와 동형).
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from app.routers.conversations import _operator_reply_target_gate_id

# --- ① _operator_reply_target_gate_id — 순수 함수 ---------------------------------------


def _root_msg(msg_metadata: dict | None):
    return SimpleNamespace(msg_metadata=msg_metadata)


def test_no_thread_root_returns_none():
    """스레드 답장이 아닌 최상위 메시지 — approval_delivery.py의 "챗 텍스트는 게이트를
    해소하지 않는다" 정책과 별개 트리거이므로, 애초에 이 훅 자체가 안 켜져야 한다."""
    assert _operator_reply_target_gate_id(None) is None


def test_reply_to_support_escalation_card_returns_gate_id():
    gate_id = uuid.uuid4()
    root_msg = _root_msg({
        "approval_target": {"work_item_type": "support_escalation", "gate_id": str(gate_id), "actions": ["approve", "reject"]},
    })
    assert _operator_reply_target_gate_id(root_msg) == gate_id


def test_reply_to_non_support_escalation_card_returns_none():
    """카드는 카드지만 다른 work_item_type(예: doc 결재) — 절대 오배달되면 안 된다."""
    root_msg = _root_msg({
        "approval_target": {"work_item_type": "doc", "gate_id": str(uuid.uuid4())},
    })
    assert _operator_reply_target_gate_id(root_msg) is None


def test_reply_to_plain_message_without_approval_target_returns_none():
    """일반 스레드 답장(카드가 아닌 평범한 메시지에 대한 답장) — approval_target 자체가 없음."""
    root_msg = _root_msg({"activation": {"kind": "request"}})
    assert _operator_reply_target_gate_id(root_msg) is None


def test_no_msg_metadata_at_all_returns_none():
    assert _operator_reply_target_gate_id(_root_msg(None)) is None
    assert _operator_reply_target_gate_id(_root_msg({})) is None


def test_missing_gate_id_returns_none():
    root_msg = _root_msg({"approval_target": {"work_item_type": "support_escalation"}})
    assert _operator_reply_target_gate_id(root_msg) is None


def test_malformed_gate_id_returns_none_not_raises():
    """실 DB 조회 없이도 여기서 안전하게 걸러야 한다 — 다음 층(deliver_operator_reply_for_gate)
    으로 malformed 값이 넘어가지 않는다."""
    root_msg = _root_msg({"approval_target": {"work_item_type": "support_escalation", "gate_id": "not-a-uuid"}})
    assert _operator_reply_target_gate_id(root_msg) is None


# --- ② deliver_operator_reply — httpx mock ------------------------------------------------


@pytest.fixture
def anyio_backend():
    return "asyncio"


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
async def test_deliver_operator_reply_success(monkeypatch):
    from app.core.config import settings
    from app.services.operator_reply_delivery import OPERATOR_REPLY_AUD, deliver_operator_reply

    monkeypatch.setattr(settings, "support_gateway_token_secret", "test-secret-padded-to-32-bytes-min")
    monkeypatch.setattr(settings, "support_gateway_operator_reply_url", "https://gateway.example/api/v1/internal/operator-replies")

    captured = {}

    async def _post(self, url, headers=None, **kwargs):
        captured["url"] = url
        captured["headers"] = headers
        return _resp(201)

    escalation_id = uuid.uuid4()
    with patch("httpx.AsyncClient.post", new=_post):
        ok = await deliver_operator_reply(escalation_id=escalation_id, content="확인했습니다.")

    assert ok is True
    assert captured["url"] == "https://gateway.example/api/v1/internal/operator-replies"

    from jose import jwt as jose_jwt
    claims = jose_jwt.get_unverified_claims(captured["headers"]["Authorization"].removeprefix("Bearer "))
    assert claims["aud"] == OPERATOR_REPLY_AUD
    assert claims["escalation_id"] == str(escalation_id)
    assert claims["content"] == "확인했습니다."


@pytest.mark.anyio
async def test_deliver_operator_reply_5xx_returns_false_not_raises(monkeypatch):
    from app.core.config import settings
    from app.services.operator_reply_delivery import deliver_operator_reply

    monkeypatch.setattr(settings, "support_gateway_token_secret", "test-secret-padded-to-32-bytes-min")
    monkeypatch.setattr(settings, "support_gateway_operator_reply_url", "https://gateway.example/x")

    with patch("httpx.AsyncClient.post", new=AsyncMock(return_value=_resp(500))):
        ok = await deliver_operator_reply(escalation_id=uuid.uuid4(), content="x")
    assert ok is False


@pytest.mark.anyio
async def test_deliver_operator_reply_network_error_returns_false_not_raises(monkeypatch):
    from app.core.config import settings
    from app.services.operator_reply_delivery import deliver_operator_reply

    monkeypatch.setattr(settings, "support_gateway_token_secret", "test-secret-padded-to-32-bytes-min")
    monkeypatch.setattr(settings, "support_gateway_operator_reply_url", "https://gateway.example/x")

    async def _post(self, url, headers=None, **kwargs):
        raise ConnectionError("network down")

    with patch("httpx.AsyncClient.post", new=_post):
        ok = await deliver_operator_reply(escalation_id=uuid.uuid4(), content="x")
    assert ok is False


@pytest.mark.anyio
async def test_deliver_operator_reply_skips_when_secret_unconfigured(monkeypatch):
    from app.core.config import settings
    from app.services.operator_reply_delivery import deliver_operator_reply

    monkeypatch.setattr(settings, "support_gateway_token_secret", "")
    monkeypatch.setattr(settings, "support_gateway_operator_reply_url", "https://gateway.example/x")
    ok = await deliver_operator_reply(escalation_id=uuid.uuid4(), content="x")
    assert ok is False


@pytest.mark.anyio
async def test_deliver_operator_reply_skips_when_url_unconfigured(monkeypatch):
    from app.core.config import settings
    from app.services.operator_reply_delivery import deliver_operator_reply

    monkeypatch.setattr(settings, "support_gateway_token_secret", "test-secret-padded-to-32-bytes-min")
    monkeypatch.setattr(settings, "support_gateway_operator_reply_url", "")
    ok = await deliver_operator_reply(escalation_id=uuid.uuid4(), content="x")
    assert ok is False
