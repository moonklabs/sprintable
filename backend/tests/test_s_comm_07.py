"""S-COMM-07: 에이전트별 inbox webhook endpoint 검증.

AC1: POST /api/v2/agent-inbox/{agent_id}/webhook → events 테이블 적재
AC2: agent_id 유효성 검증 — 없으면 404
AC3: HMAC 서명 검증 — X-Sprintable-Signature
"""
from __future__ import annotations

import hashlib
import hmac
import inspect
import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── AC1: 라우터 등록 확인 ────────────────────────────────────────────────────

def test_agent_inbox_router_registered():
    """agent_inbox 라우터가 main.py에 등록됨."""
    import app.main as main_module
    source = inspect.getsource(main_module)
    assert "agent_inbox" in source


def test_agent_inbox_router_prefix():
    """router prefix가 /api/v2/agent-inbox."""
    from app.routers.agent_inbox import router
    assert router.prefix == "/api/v2/agent-inbox"


# ─── AC3: HMAC 서명 검증 로직 ─────────────────────────────────────────────────

def test_verify_signature_passes_when_no_secret():
    """secret 미설정 시 서명 없어도 통과 (dev 환경)."""
    from app.routers.agent_inbox import _verify_signature
    with patch("app.routers.agent_inbox.settings") as mock_settings:
        mock_settings.agent_inbox_webhook_secret = ""
        assert _verify_signature(b"body", None) is True
        assert _verify_signature(b"body", "sha256=anything") is True


def test_verify_signature_rejects_missing_header():
    """secret 설정 시 헤더 없으면 False."""
    from app.routers.agent_inbox import _verify_signature
    with patch("app.routers.agent_inbox.settings") as mock_settings:
        mock_settings.agent_inbox_webhook_secret = "testsecret"
        assert _verify_signature(b"body", None) is False


def test_verify_signature_passes_valid_hmac():
    """올바른 HMAC sha256= 헤더는 True."""
    from app.routers.agent_inbox import _verify_signature
    secret = "testsecret"
    body = b'{"event_type":"test"}'
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    with patch("app.routers.agent_inbox.settings") as mock_settings:
        mock_settings.agent_inbox_webhook_secret = secret
        assert _verify_signature(body, f"sha256={expected}") is True


def test_verify_signature_rejects_wrong_hmac():
    """틀린 HMAC은 False."""
    from app.routers.agent_inbox import _verify_signature
    with patch("app.routers.agent_inbox.settings") as mock_settings:
        mock_settings.agent_inbox_webhook_secret = "testsecret"
        assert _verify_signature(b"body", "sha256=deadbeef") is False


# ─── AC2 + AC1: 엔드포인트 동작 검증 ─────────────────────────────────────────

@pytest.mark.anyio
async def test_receive_inbox_webhook_404_when_agent_not_found():
    """없는 agent_id → 404."""
    from fastapi import HTTPException
    from app.routers.agent_inbox import receive_inbox_webhook

    mock_request = MagicMock()
    mock_request.body = AsyncMock(return_value=b'{"event_type":"test"}')

    mock_db = AsyncMock()
    mock_result = MagicMock()
    mock_result.one_or_none.return_value = None
    mock_db.execute = AsyncMock(return_value=mock_result)

    with patch("app.routers.agent_inbox.settings") as mock_settings:
        mock_settings.agent_inbox_webhook_secret = ""
        with pytest.raises(HTTPException) as exc_info:
            await receive_inbox_webhook(
                agent_id=uuid.uuid4(),
                request=mock_request,
                db=mock_db,
                x_sprintable_signature=None,
            )
    assert exc_info.value.status_code == 404


@pytest.mark.anyio
async def test_receive_inbox_webhook_401_on_bad_signature():
    """잘못된 서명 → 401."""
    from fastapi import HTTPException
    from app.routers.agent_inbox import receive_inbox_webhook

    mock_request = MagicMock()
    mock_request.body = AsyncMock(return_value=b'{"event_type":"test"}')

    mock_db = AsyncMock()

    with patch("app.routers.agent_inbox.settings") as mock_settings:
        mock_settings.agent_inbox_webhook_secret = "secret"
        with pytest.raises(HTTPException) as exc_info:
            await receive_inbox_webhook(
                agent_id=uuid.uuid4(),
                request=mock_request,
                db=mock_db,
                x_sprintable_signature="sha256=wrong",
            )
    assert exc_info.value.status_code == 401


@pytest.mark.anyio
async def test_receive_inbox_webhook_creates_event():
    """유효한 agent_id + 올바른 서명 → Event 생성 후 event_id 반환 (AC1)."""
    from app.routers.agent_inbox import receive_inbox_webhook

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    agent_id = uuid.uuid4()
    event_id = uuid.uuid4()

    body = json.dumps({"event_type": "story_assigned", "data": "hello"}).encode()

    mock_request = MagicMock()
    mock_request.body = AsyncMock(return_value=body)

    mock_db = AsyncMock()

    # execute: agent lookup 반환
    agent_row = MagicMock()
    agent_row.__iter__ = MagicMock(return_value=iter([org_id, project_id]))
    lookup_result = MagicMock()
    lookup_result.one_or_none.return_value = (org_id, project_id)
    mock_db.execute = AsyncMock(return_value=lookup_result)

    mock_event = MagicMock()
    mock_event.id = event_id

    def fake_add(obj):
        obj.id = event_id

    mock_db.add = MagicMock(side_effect=fake_add)
    mock_db.commit = AsyncMock()
    mock_db.refresh = AsyncMock()

    with patch("app.routers.agent_inbox.settings") as mock_settings:
        mock_settings.agent_inbox_webhook_secret = ""
        with patch("app.routers.agent_inbox.Event") as MockEvent:
            MockEvent.return_value = mock_event
            result = await receive_inbox_webhook(
                agent_id=agent_id,
                request=mock_request,
                db=mock_db,
                x_sprintable_signature=None,
            )

    assert result["ok"] is True
    assert "event_id" in result
    mock_db.commit.assert_awaited_once()


# ─── config 필드 존재 확인 ────────────────────────────────────────────────────

def test_agent_inbox_webhook_secret_in_config():
    """Settings에 agent_inbox_webhook_secret 필드 존재."""
    from app.core.config import Settings
    s = Settings()
    assert hasattr(s, "agent_inbox_webhook_secret")
    assert s.agent_inbox_webhook_secret == ""
