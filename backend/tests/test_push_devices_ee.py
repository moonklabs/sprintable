"""E-MOBILE M0·S2: push_devices EE 라우터 단위 계약 테스트.

DB 불요(AsyncMock repo·router 함수 직접 호출) — webhook test_notif_trust_testsend 동형 스타일.
핵심 계약: ①등록 member_id = caller 강제(body 없음·IDOR) ②list/delete member-scope ③delete 404
④_get_caller_member_id = resolve_member().id ⑤토큰 포맷/platform 검증. realdb 왕복(등록→조회→폐기)은
PR 본문 curl 증거로 별도 첨부.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from pydantic import ValidationError

from app.schemas.push_device import RegisterPushDevice


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _device_ns(member_id: uuid.UUID, org_id: uuid.UUID | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid.uuid4(),
        org_id=org_id or uuid.uuid4(),
        member_id=member_id,
        expo_push_token="ExponentPushToken[abc123]",
        platform="ios",
        device_id=None,
        app_version=None,
        is_active=True,
        created_at=datetime(2026, 7, 15, tzinfo=timezone.utc),
        last_seen_at=datetime(2026, 7, 15, tzinfo=timezone.utc),
    )


# ─── 스키마 검증(토큰 포맷·platform) ──────────────────────────────────────────

def test_register_schema_accepts_valid_expo_token():
    body = RegisterPushDevice(expo_push_token="ExponentPushToken[xxxYYY-123_.]", platform="ios")
    assert body.expo_push_token == "ExponentPushToken[xxxYYY-123_.]"
    assert body.platform == "ios"


def test_register_schema_accepts_short_expo_prefix():
    body = RegisterPushDevice(expo_push_token="ExpoPushToken[abc]", platform="android")
    assert body.expo_push_token == "ExpoPushToken[abc]"


def test_register_schema_rejects_non_expo_token():
    with pytest.raises(ValidationError):
        RegisterPushDevice(expo_push_token="not-a-token", platform="ios")


def test_register_schema_rejects_raw_fcm_token():
    # crux §2: 클라 제출값 방어적 검증 — ExponentPushToken 포맷 아니면 거부.
    with pytest.raises(ValidationError):
        RegisterPushDevice(expo_push_token="fGx9:APA91bH_rawFcmToken", platform="android")


def test_register_schema_rejects_bad_platform():
    with pytest.raises(ValidationError):
        RegisterPushDevice(expo_push_token="ExponentPushToken[abc]", platform="windows")


# ─── 등록: member_id = caller 강제(IDOR·body 무신뢰) ──────────────────────────

@pytest.mark.anyio
async def test_register_forces_caller_member_id():
    from ee.routers.push_devices import register_push_device
    caller = uuid.uuid4()
    repo = AsyncMock()
    repo.upsert = AsyncMock(return_value=_device_ns(caller))
    body = RegisterPushDevice(expo_push_token="ExponentPushToken[abc]", platform="ios")

    out = await register_push_device(body, repo=repo, caller_member_id=caller, _ee=None)

    # member_id 는 caller 로 강제(body 에 member_id 아예 없음).
    assert repo.upsert.await_args.kwargs["member_id"] == caller
    assert repo.upsert.await_args.kwargs["expo_push_token"] == "ExponentPushToken[abc]"
    assert repo.upsert.await_args.kwargs["platform"] == "ios"
    assert out.member_id == caller  # 응답도 caller 소유


# ─── 조회: member-scope(org-wide leak 차단) ───────────────────────────────────

@pytest.mark.anyio
async def test_list_is_member_scoped():
    from ee.routers.push_devices import list_push_devices
    caller = uuid.uuid4()
    repo = AsyncMock()
    repo.list = AsyncMock(return_value=[_device_ns(caller)])

    out = await list_push_devices(repo=repo, caller_member_id=caller, _ee=None)

    assert repo.list.await_args.kwargs["member_id"] == caller  # caller member-scope
    assert len(out) == 1
    assert out[0].member_id == caller


# ─── 폐기: 소유 검증(get_owned 기반)·타 멤버/없는 id 404 ──────────────────────

@pytest.mark.anyio
async def test_revoke_is_member_scoped_and_404_for_other():
    from fastapi import HTTPException

    from ee.routers.push_devices import revoke_push_device
    caller = uuid.uuid4()
    repo = AsyncMock()
    repo.delete = AsyncMock(return_value=False)  # 타 멤버/없는 id → 0행

    with pytest.raises(HTTPException) as ei:
        await revoke_push_device(id=uuid.uuid4(), repo=repo, caller_member_id=caller, _ee=None)

    assert ei.value.status_code == 404
    assert repo.delete.await_args.args[1] == caller  # caller member 로 소유 검증


@pytest.mark.anyio
async def test_revoke_ok_when_owned():
    from ee.routers.push_devices import revoke_push_device
    caller = uuid.uuid4()
    repo = AsyncMock()
    repo.delete = AsyncMock(return_value=True)

    out = await revoke_push_device(id=uuid.uuid4(), repo=repo, caller_member_id=caller, _ee=None)

    assert out == {"ok": True}


# ─── 멤버 축 정합: _get_caller_member_id = resolve_member().id ─────────────────

@pytest.mark.anyio
async def test_caller_member_id_uses_resolve_member_not_user_id():
    """webhook 동형 — resolve_member().id(휴먼=org_member.id·에이전트=team_member.id). users.id 축 아님."""
    from ee.routers.push_devices import _get_caller_member_id
    org_member_id = uuid.uuid4()
    users_id = uuid.uuid4()
    auth = SimpleNamespace(user_id=str(users_id))
    with patch("app.services.member_resolver.resolve_member",
               new=AsyncMock(return_value=SimpleNamespace(id=org_member_id))):
        out = await _get_caller_member_id(auth=auth, org_id=uuid.uuid4(), session=AsyncMock())
    assert out == org_member_id
    assert out != users_id


# ─── EE 가드: 비활성 환경 403 ─────────────────────────────────────────────────

def test_require_ee_raises_when_disabled():
    from fastapi import HTTPException

    from ee.routers.push_devices import _require_ee
    with patch("ee.routers.push_devices.settings", SimpleNamespace(is_ee_enabled=False)):
        with pytest.raises(HTTPException) as ei:
            _require_ee()
    assert ei.value.status_code == 403


def test_require_ee_passes_when_enabled():
    from ee.routers.push_devices import _require_ee
    with patch("ee.routers.push_devices.settings", SimpleNamespace(is_ee_enabled=True)):
        assert _require_ee() is None
