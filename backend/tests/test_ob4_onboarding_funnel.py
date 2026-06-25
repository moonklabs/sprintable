"""OB-4: 온보딩 funnel 계측 가드 (측정계약 doc §1/§2/§4).

이벤트 카탈로그·PII 가드(전체키 reject)·emit begin_nested 격리(fail-silent)·POST 엔드포인트
(enum 422·PII 422·optional auth 서버-truth·저장).
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.onboarding_event import OnboardingEvent
from app.routers.onboarding import OnboardingEventBody, post_onboarding_event
from app.services import onboarding_funnel as f


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ─── 카탈로그 / PII 가드 ──────────────────────────────────────────────────────

def test_event_catalog_has_canonical_11():
    assert len(f.EVENT_CATALOG) == 11
    assert "config_generated" in f.EVENT_CATALOG and "verified" in f.EVENT_CATALOG
    assert len(f.BE_EMIT_EVENTS) == 8
    assert len(f.FAILURE_REASONS) == 8


def test_contains_secret_detects_full_key_not_prefix():
    assert f.contains_secret("sk_" + "live_" + "z" * 28) is True
    assert f.contains_secret({"meta": {"k": "sk_test_" + "a" * 24}}) is True
    assert f.contains_secret(["x", ["sk_live_" + "b" * 30]]) is True
    assert f.contains_secret("sk_live_") is False  # prefix-only(짧음) 통과
    assert f.contains_secret({"event": "verified", "key_prefix": "sk_live_"}) is False


def test_safe_key_prefix_truncates():
    assert f.safe_key_prefix("sk_" + "live_" + "z" * 21) == "sk_live_zzzz"  # 첫 12자
    assert len(f.safe_key_prefix("sk_live_xxxxxxxxxxxxx")) <= f.KEY_PREFIX_MAX
    assert f.safe_key_prefix(None) is None


# ─── emit begin_nested 격리(fail-silent) ──────────────────────────────────────

def _nested_cm():
    cm = AsyncMock()
    cm.__aenter__ = AsyncMock(return_value=None)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


@pytest.mark.anyio
async def test_emit_uses_begin_nested_and_records():
    db = AsyncMock()
    db.add = MagicMock()
    db.flush = AsyncMock()
    db.begin_nested = MagicMock(return_value=_nested_cm())
    await f.emit_onboarding_event(db, "config_generated", agent_id=uuid.uuid4())
    db.begin_nested.assert_called_once()  # SAVEPOINT 격리
    db.add.assert_called_once()
    assert isinstance(db.add.call_args[0][0], OnboardingEvent)


@pytest.mark.anyio
async def test_emit_fail_silent_does_not_raise():
    db = AsyncMock()
    db.begin_nested = MagicMock(side_effect=RuntimeError("boom"))
    # 실패해도 예외 전파 0(측정이 UX 안 막음)
    await f.emit_onboarding_event(db, "verified", agent_id=uuid.uuid4())


# ─── POST /onboarding/events ──────────────────────────────────────────────────

def _db():
    db = AsyncMock()
    db.add = MagicMock()
    db.flush = AsyncMock()
    db.commit = AsyncMock()
    return db


@pytest.mark.anyio
async def test_post_unknown_event_422():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        await post_onboarding_event(
            OnboardingEventBody(event="bogus_event"), db=_db(), credentials=None, x_agent_api_key=None
        )
    assert ei.value.status_code == 422


@pytest.mark.anyio
async def test_post_secret_in_meta_rejected_422():
    from fastapi import HTTPException
    body = OnboardingEventBody(event="config_copied", meta={"leak": "sk_live_" + "a" * 30})
    with pytest.raises(HTTPException) as ei:
        await post_onboarding_event(body, db=_db(), credentials=None, x_agent_api_key=None)
    assert ei.value.status_code == 422 and "secret" in ei.value.detail


@pytest.mark.anyio
async def test_post_anonymous_pre_auth_stores():
    db = _db()
    sess = uuid.uuid4()
    body = OnboardingEventBody(event="onboarding_started", session_id=sess, runtime="claude-code")
    out = await post_onboarding_event(body, db=db, credentials=None, x_agent_api_key=None)
    assert out == {"ok": True}
    row = db.add.call_args[0][0]
    assert row.event == "onboarding_started" and row.session_id == sess and row.agent_id is None
    db.commit.assert_awaited_once()


# ─── RC-1: choke-point PII 방어(record 전 경로) ───────────────────────────────

@pytest.mark.anyio
async def test_record_rejects_secret_in_meta_choke_point():
    """record_onboarding_event(전 경로 초크포인트)가 meta 속 전체키를 막는다(endpoint 우회 차단)."""
    db = AsyncMock()
    db.add = MagicMock()
    db.flush = AsyncMock()
    with pytest.raises(ValueError):
        await f.record_onboarding_event(
            db, event="config_copied", meta={"api_key": "sk_" + "live_" + "z" * 30}
        )
    db.add.assert_not_called()  # secret이면 저장 0


@pytest.mark.anyio
async def test_emit_swallows_secret_meta_not_stored():
    """BE emit이 secret meta 받아도 record raise→fail-silent로 미저장(예외 전파 0)."""
    db = AsyncMock()
    db.add = MagicMock()
    db.begin_nested = MagicMock(return_value=_nested_cm())
    await f.emit_onboarding_event(db, "config_generated", meta={"leak": "sk_" + "live_" + "z" * 30})
    db.add.assert_not_called()


# ─── RC-2: pre-auth client agent_id 스푸핑 차단 ───────────────────────────────

@pytest.mark.anyio
async def test_post_pre_auth_ignores_client_agent_id():
    """무인증이면 client-supplied agent_id 무시(None)·session_id만 신뢰(스푸핑 차단)."""
    db = _db()
    spoofed = uuid.uuid4()
    sess = uuid.uuid4()
    body = OnboardingEventBody(event="config_copied", session_id=sess, agent_id=spoofed)
    await post_onboarding_event(body, db=db, credentials=None, x_agent_api_key=None)
    row = db.add.call_args[0][0]
    assert row.agent_id is None and row.key_prefix is None  # 클라 불신
    assert row.session_id == sess  # session_id만 신뢰


@pytest.mark.anyio
async def test_post_authed_derives_server_truth():
    """키 있으면 agent_id/org_id/key_prefix를 서버가 도출(클라 agent_id 무시)."""
    db = _db()
    real_agent = uuid.uuid4()
    real_org = uuid.uuid4()
    ctx = SimpleNamespace(
        user_id=str(real_agent),
        claims={"app_metadata": {"org_id": str(real_org), "project_id": None, "api_key_id": "k"}},
    )
    body = OnboardingEventBody(event="first_auth_seen", agent_id=uuid.uuid4())  # 클라가 보낸 가짜 agent_id
    with patch("app.routers.onboarding._resolve_api_key", new=AsyncMock(return_value=ctx)):
        await post_onboarding_event(
            body, db=db, credentials=None, x_agent_api_key="sk_" + "live_" + "z" * 26
        )
    row = db.add.call_args[0][0]
    assert row.agent_id == real_agent  # 서버-truth(클라 무시)
    assert row.org_id == real_org
    assert row.key_prefix == "sk_live_zzzz" and len(row.key_prefix) <= f.KEY_PREFIX_MAX
