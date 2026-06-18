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

def test_verify_signature_rejects_when_no_secret():
    """secret 미설정 시 서명 없어도 거부 (secure-by-default, S-COMM-FIX AC2)."""
    from app.routers.agent_inbox import _verify_signature
    with patch("app.routers.agent_inbox.settings") as mock_settings:
        mock_settings.agent_inbox_webhook_secret = ""
        assert _verify_signature(b"body", None) is False
        assert _verify_signature(b"body", "sha256=anything") is False


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
    """없는 agent_id + 유효 서명 → 404 (서명 통과 후 agent 조회 실패)."""
    from fastapi import HTTPException
    from app.routers.agent_inbox import receive_inbox_webhook

    secret = "testsecret"
    body = b'{"event_type":"test"}'
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    mock_request = MagicMock()
    mock_request.body = AsyncMock(return_value=body)

    mock_db = AsyncMock()
    mock_result = MagicMock()
    mock_result.all.return_value = []  # 2c457a06: grant 전수 조회(.all) — 없으면 404
    mock_db.execute = AsyncMock(return_value=mock_result)

    with patch("app.routers.agent_inbox.settings") as mock_settings:
        mock_settings.agent_inbox_webhook_secret = secret
        with pytest.raises(HTTPException) as exc_info:
            await receive_inbox_webhook(
                agent_id=uuid.uuid4(),
                request=mock_request,
                db=mock_db,
                x_sprintable_signature=sig,
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

    # execute: agent grant 전수 조회(.all) — 단일 grant
    lookup_result = MagicMock()
    lookup_result.all.return_value = [(org_id, project_id)]
    mock_db.execute = AsyncMock(return_value=lookup_result)

    mock_event = MagicMock()
    mock_event.id = event_id

    def fake_add(obj):
        obj.id = event_id

    mock_db.add = MagicMock(side_effect=fake_add)
    mock_db.commit = AsyncMock()
    mock_db.refresh = AsyncMock()

    secret = "testsecret"
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    with patch("app.routers.agent_inbox.settings") as mock_settings:
        mock_settings.agent_inbox_webhook_secret = secret
        with patch("app.routers.agent_inbox.Event") as MockEvent:
            MockEvent.return_value = mock_event
            result = await receive_inbox_webhook(
                agent_id=agent_id,
                request=mock_request,
                db=mock_db,
                x_sprintable_signature=sig,
            )

    assert result["ok"] is True
    assert "event_id" in result
    mock_db.commit.assert_awaited_once()


@pytest.mark.anyio
async def test_receive_inbox_webhook_401_when_no_secret_or_no_sig():
    """무서명 또는 secret 미설정 → 401 (secure-by-default 회귀 방지, S-COMM-FIX AC2)."""
    from fastapi import HTTPException
    from app.routers.agent_inbox import receive_inbox_webhook

    mock_request = MagicMock()
    mock_request.body = AsyncMock(return_value=b'{"event_type":"test"}')
    mock_db = AsyncMock()

    # case A: secret 없음 + 서명 없음
    with patch("app.routers.agent_inbox.settings") as mock_settings:
        mock_settings.agent_inbox_webhook_secret = ""
        with pytest.raises(HTTPException) as exc_info:
            await receive_inbox_webhook(
                agent_id=uuid.uuid4(), request=mock_request, db=mock_db, x_sprintable_signature=None
            )
    assert exc_info.value.status_code == 401

    # case B: secret 있음 + 서명 없음
    with patch("app.routers.agent_inbox.settings") as mock_settings:
        mock_settings.agent_inbox_webhook_secret = "testsecret"
        with pytest.raises(HTTPException) as exc_info:
            await receive_inbox_webhook(
                agent_id=uuid.uuid4(), request=mock_request, db=mock_db, x_sprintable_signature=None
            )
    assert exc_info.value.status_code == 401


# ─── config 필드 존재 확인 ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_receive_inbox_webhook_calls_push_to_agent():
    """commit 후 _push_to_agent 호출로 SSE 즉시 push (AC4)."""
    from app.routers.agent_inbox import receive_inbox_webhook

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    agent_id = uuid.uuid4()

    body = json.dumps({"event_type": "inbox_webhook"}).encode()
    mock_request = MagicMock()
    mock_request.body = AsyncMock(return_value=body)

    mock_db = AsyncMock()
    lookup_result = MagicMock()
    lookup_result.all.return_value = [(org_id, project_id)]
    mock_db.execute = AsyncMock(return_value=lookup_result)

    mock_event = MagicMock()
    mock_event.id = uuid.uuid4()
    mock_db.add = MagicMock(side_effect=lambda obj: setattr(obj, "id", mock_event.id))
    mock_db.commit = AsyncMock()
    mock_db.refresh = AsyncMock()

    secret = "testsecret"
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    with patch("app.routers.agent_inbox.settings") as mock_settings:
        mock_settings.agent_inbox_webhook_secret = secret
        with patch("app.routers.agent_inbox.Event") as MockEvent:
            MockEvent.return_value = mock_event
            with patch("app.routers.events._push_to_agent") as mock_push:
                await receive_inbox_webhook(
                    agent_id=agent_id,
                    request=mock_request,
                    db=mock_db,
                    x_sprintable_signature=sig,
                )
                mock_push.assert_called_once_with(str(agent_id), {"event_type": "inbox_webhook"})


def test_agent_inbox_webhook_secret_in_config():
    """Settings에 agent_inbox_webhook_secret 필드 존재."""
    from app.core.config import Settings
    s = Settings()
    assert hasattr(s, "agent_inbox_webhook_secret")
    assert s.agent_inbox_webhook_secret == ""


# ─── 2c457a06 true-routing: payload project_id 우선(grant 검증)·없으면 default ──────
async def _run_inbox_with_grants(payload: dict, grants: list[tuple]):
    """주어진 grant 목록 + payload 로 receive_inbox_webhook 실행 → 생성 Event 의 project_id 반환."""
    from app.routers.agent_inbox import receive_inbox_webhook

    agent_id = uuid.uuid4()
    body = json.dumps(payload).encode()
    mock_request = MagicMock()
    mock_request.body = AsyncMock(return_value=body)

    mock_db = AsyncMock()
    lookup_result = MagicMock()
    lookup_result.all.return_value = grants  # (org_id, project_id) 행들
    mock_db.execute = AsyncMock(return_value=lookup_result)
    mock_db.add = MagicMock(side_effect=lambda obj: setattr(obj, "id", uuid.uuid4()))
    mock_db.commit = AsyncMock()
    mock_db.refresh = AsyncMock()

    secret = "testsecret"
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

    captured: dict = {}
    with patch("app.routers.agent_inbox.settings") as mock_settings:
        mock_settings.agent_inbox_webhook_secret = secret
        with patch("app.routers.agent_inbox.Event") as MockEvent:
            def _capture(**kwargs):
                captured.update(kwargs)
                m = MagicMock()
                m.id = uuid.uuid4()
                return m
            MockEvent.side_effect = _capture
            with patch("app.routers.events._push_to_agent"):
                await receive_inbox_webhook(
                    agent_id=agent_id, request=mock_request, db=mock_db, x_sprintable_signature=sig,
                )
    return captured.get("project_id")


@pytest.mark.anyio
async def test_inbox_explicit_granted_project_id_routes():
    """payload 가 명시한 project_id 가 grant 에 속하면 그 project 로 Event 라우팅."""
    org = uuid.uuid4()
    p1, p2 = uuid.uuid4(), uuid.uuid4()
    grants = sorted([(org, p1), (org, p2)], key=lambda r: str(r[1]))  # order_by(project_id)
    target = p2
    result_pid = await _run_inbox_with_grants({"event_type": "x", "project_id": str(target)}, grants)
    assert result_pid == target


@pytest.mark.anyio
async def test_inbox_ungranted_project_id_falls_back_to_default():
    """payload project_id 가 grant 밖이면 deterministic default(첫 행) 로 fallback(IDOR 차단·전달 무중단)."""
    org = uuid.uuid4()
    p1, p2 = uuid.uuid4(), uuid.uuid4()
    grants = sorted([(org, p1), (org, p2)], key=lambda r: str(r[1]))
    outsider = uuid.uuid4()  # grant 밖
    result_pid = await _run_inbox_with_grants({"event_type": "x", "project_id": str(outsider)}, grants)
    assert result_pid == grants[0][1]  # default = 첫(정렬) grant


@pytest.mark.anyio
async def test_inbox_no_project_id_uses_default():
    """payload 에 project_id 없으면 default(첫 grant)."""
    org = uuid.uuid4()
    p1, p2 = uuid.uuid4(), uuid.uuid4()
    grants = sorted([(org, p1), (org, p2)], key=lambda r: str(r[1]))
    result_pid = await _run_inbox_with_grants({"event_type": "x"}, grants)
    assert result_pid == grants[0][1]
