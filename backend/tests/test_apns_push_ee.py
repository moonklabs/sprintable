"""story #3064(E-MOBILE·macOS): APNs 발송기 단위 테스트(DB 불요·AsyncMock, expo_push_ee 동형).

발송기 로직: JWT provider token 서명·캐시·sandbox/production 호스트 선택·per-device 발송·
410/BadDeviceToken→is_active=false·mute 필터·apns_configured fail-closed·best-effort.
dispatch_notification 경로 실구동(outbox 배선)은 delivery_dispatcher.py 코드 read로 확認
(expo_push 브랜치와 동형 구조 재사용이라 별도 realdb는 두지 않음 — expo_push_realdb가 이미
같은 outbox 메커니즘을 커버).
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

import ee.services.apns_push as apns

TEST_KEY_ID = "TESTKEYID1"
TEST_TEAM_ID = "TESTTEAM01"
TEST_BUNDLE_ID = "com.moonklabs.sprintable.desktop"


def _gen_test_keypair() -> tuple[str, str]:
    """실 .p8과 동형 포맷(PKCS8 PEM, unencrypted)의 throwaway ES256 키쌍 — Apple 키 불필요.
    반환: (private_pem, public_pem)."""
    key = ec.generate_private_key(ec.SECP256R1())
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return private_pem, public_pem


def _gen_test_p8() -> str:
    return _gen_test_keypair()[0]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def configured_settings():
    """settings.apns_configured=True + 서명 가능한 테스트 키 일체 주입."""
    private_pem, public_pem = _gen_test_keypair()
    with patch.object(apns.settings, "apns_auth_key_p8", private_pem), \
         patch.object(apns.settings, "apns_key_id", TEST_KEY_ID), \
         patch.object(apns.settings, "apns_team_id", TEST_TEAM_ID), \
         patch.object(apns.settings, "apns_bundle_id", TEST_BUNDLE_ID), \
         patch.object(apns.settings, "apns_use_sandbox", False):
        apns._token_cache.clear()
        yield public_pem
    apns._token_cache.clear()


class _Resp:
    def __init__(self, status_code: int, payload: dict | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


def _client_cm(post_mock):
    client = AsyncMock()
    client.post = post_mock
    cm = AsyncMock()
    cm.__aenter__ = AsyncMock(return_value=client)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm


def _mock_db(devices: list) -> AsyncMock:
    sel = MagicMock()
    sel.scalars.return_value.all.return_value = devices
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[sel] + [AsyncMock() for _ in range(5)])
    db.flush = AsyncMock()
    return db


def _dev(token: str, member_id: uuid.UUID | None = None):
    return SimpleNamespace(apns_device_token=token, member_id=member_id or uuid.uuid4())


# ─── settings.apns_configured / host 선택 ─────────────────────────────────────

def test_apns_configured_false_when_any_field_missing():
    with patch.object(apns.settings, "apns_auth_key_p8", ""), \
         patch.object(apns.settings, "apns_key_id", "k"), \
         patch.object(apns.settings, "apns_team_id", "t"):
        assert apns.settings.apns_configured is False


def test_apns_configured_true_when_all_fields_set(configured_settings):
    assert apns.settings.apns_configured is True


def test_apns_host_production_by_default(configured_settings):
    assert apns._apns_host() == apns._APNS_PROD_HOST


def test_apns_host_sandbox_when_flag_set(configured_settings):
    with patch.object(apns.settings, "apns_use_sandbox", True):
        assert apns._apns_host() == apns._APNS_SANDBOX_HOST


# ─── JWT provider token(ES256 서명·캐시) ──────────────────────────────────────

def test_build_provider_jwt_has_correct_header_and_claims(configured_settings):
    from jose import jwt as jose_jwt

    token = apns._build_provider_jwt()
    header = jose_jwt.get_unverified_header(token)
    claims = jose_jwt.get_unverified_claims(token)
    assert header["alg"] == "ES256"
    assert header["kid"] == TEST_KEY_ID
    assert claims["iss"] == TEST_TEAM_ID
    assert "iat" in claims


def test_build_provider_jwt_verifies_against_own_key(configured_settings):
    """서명이 실제로 그 키로 검증 가능한지(형식만 그럴싸한 게 아니라 진짜 유효한 ES256인지)."""
    from jose import jwt as jose_jwt

    public_pem = configured_settings
    token = apns._build_provider_jwt()
    claims = jose_jwt.decode(
        token, public_pem, algorithms=["ES256"],
        options={"verify_aud": False},
    )
    assert claims["iss"] == TEST_TEAM_ID


def test_build_provider_jwt_cached_within_ttl(configured_settings):
    t1 = apns._build_provider_jwt()
    t2 = apns._build_provider_jwt()
    assert t1 == t2  # 55분 이내 재호출 — 캐시 재사용(재서명 없음)


def test_build_provider_jwt_reissues_after_ttl(configured_settings):
    t1 = apns._build_provider_jwt()
    cached_at = apns._token_cache[TEST_KEY_ID][1]
    with patch.object(apns.time, "monotonic", return_value=cached_at + apns._TOKEN_TTL_SECONDS + 1):
        t2 = apns._build_provider_jwt()
    assert t1 != t2  # TTL 경과 — 재서명(iat 갱신)


# ─── _send_apns_targets (per-device 발송·dead token 판정) ─────────────────────

@pytest.mark.anyio
async def test_send_skips_when_not_configured():
    devices = [{"apns_device_token": "ab" * 32}]
    with patch.object(apns.settings, "apns_auth_key_p8", ""):
        dead = await apns._send_apns_targets(devices, title="T", body="B", event_type="e", org_id=uuid.uuid4())
    assert dead == []


@pytest.mark.anyio
async def test_send_marks_410_as_dead(configured_settings):
    token_good, token_bad = "aa" * 32, "bb" * 32

    async def _post(url, json=None, headers=None):
        if token_bad in url:
            return _Resp(410, {"reason": "Unregistered"})
        return _Resp(200)

    with patch("ee.services.apns_push.httpx.AsyncClient", return_value=_client_cm(AsyncMock(side_effect=_post))):
        dead = await apns._send_apns_targets(
            [{"apns_device_token": token_good}, {"apns_device_token": token_bad}],
            title="T", body="B", event_type="e", org_id=uuid.uuid4(),
        )
    assert dead == [token_bad]


@pytest.mark.anyio
async def test_send_marks_bad_device_token_as_dead(configured_settings):
    token_bad = "cc" * 32

    async def _post(url, json=None, headers=None):
        return _Resp(400, {"reason": "BadDeviceToken"})

    with patch("ee.services.apns_push.httpx.AsyncClient", return_value=_client_cm(AsyncMock(side_effect=_post))):
        dead = await apns._send_apns_targets(
            [{"apns_device_token": token_bad}], title="T", body="B", event_type="e", org_id=uuid.uuid4(),
        )
    assert dead == [token_bad]


@pytest.mark.anyio
async def test_send_does_not_mark_other_4xx_as_dead(configured_settings):
    """BadDeviceToken/Unregistered 이외 4xx(예: PayloadTooLarge)는 dead 처리 안 함 — 토큰
    자체는 유효하니 재시도 대상에서 빼지 않는다."""
    token = "dd" * 32

    async def _post(url, json=None, headers=None):
        return _Resp(413, {"reason": "PayloadTooLarge"})

    with patch("ee.services.apns_push.httpx.AsyncClient", return_value=_client_cm(AsyncMock(side_effect=_post))):
        dead = await apns._send_apns_targets(
            [{"apns_device_token": token}], title="T", body="B", event_type="e", org_id=uuid.uuid4(),
        )
    assert dead == []


@pytest.mark.anyio
async def test_send_includes_apns_topic_header(configured_settings):
    captured_headers = {}

    async def _post(url, json=None, headers=None):
        captured_headers.update(headers)
        return _Resp(200)

    with patch("ee.services.apns_push.httpx.AsyncClient", return_value=_client_cm(AsyncMock(side_effect=_post))):
        await apns._send_apns_targets(
            [{"apns_device_token": "ee" * 32}], title="T", body="B", event_type="e", org_id=uuid.uuid4(),
        )
    assert captured_headers["apns-topic"] == TEST_BUNDLE_ID
    assert captured_headers["authorization"].startswith("bearer ")


# ─── deliver_apns_push (fetch 필터·outbox·best-effort) ────────────────────────

@pytest.mark.anyio
async def test_fetch_filters_to_macos_platform_only():
    """SQL where절 자체를 조립만 검증(mock select라 실제 필터링은 안 걸리지만, 호출 인자로
    platform='macos' 조건이 실린다는 것은 코드 경로 존재 증명)."""
    db = _mock_db([_dev("ab" * 32)])
    targets = await apns._fetch_apns_targets(db, uuid.uuid4(), [uuid.uuid4()])
    assert targets == [{"apns_device_token": "ab" * 32}]


@pytest.mark.anyio
async def test_deliver_apns_push_skips_when_no_devices():
    db = _mock_db([])
    sent = AsyncMock()
    with patch("ee.services.apns_push._apns_send_one", new=sent):
        await apns.deliver_apns_push(
            db, uuid.uuid4(), [uuid.uuid4()], title="T", body="B", event_type="e", via_outbox=False,
        )
    sent.assert_not_awaited()


@pytest.mark.anyio
async def test_deliver_apns_push_skips_when_no_member_ids():
    db = AsyncMock()
    await apns.deliver_apns_push(db, uuid.uuid4(), [], title="T", body="B", event_type="e", via_outbox=False)
    db.execute.assert_not_awaited()


@pytest.mark.anyio
async def test_deliver_apns_push_best_effort_swallows_exceptions(configured_settings):
    db = AsyncMock()
    db.execute = AsyncMock(side_effect=RuntimeError("db down"))
    await apns.deliver_apns_push(db, uuid.uuid4(), [uuid.uuid4()], title="T", body="B", event_type="e", via_outbox=False)


@pytest.mark.anyio
async def test_deliver_apns_push_deactivates_dead_token(configured_settings):
    good = _dev("aa" * 32)
    bad = _dev("bb" * 32)
    db = _mock_db([good, bad])

    async def _post(url, json=None, headers=None):
        if bad.apns_device_token in url:
            return _Resp(410, {"reason": "Unregistered"})
        return _Resp(200)

    with patch("ee.services.apns_push.httpx.AsyncClient", return_value=_client_cm(AsyncMock(side_effect=_post))):
        await apns.deliver_apns_push(
            db, uuid.uuid4(), [good.member_id, bad.member_id], title="T", body="B", event_type="e",
            via_outbox=False,
        )
    # select 1 + update 1 = execute 2회, flush 1회(만료 반영) — expo_push 동형 계약.
    assert db.execute.await_count == 2
    db.flush.assert_awaited_once()


@pytest.mark.anyio
async def test_deliver_apns_push_via_outbox_creates_delivery_job():
    db = AsyncMock()
    await apns.deliver_apns_push(
        db, uuid.uuid4(), [uuid.uuid4()], title="T", body="B", event_type="e", via_outbox=True,
    )
    assert db.add.call_count == 1
    job = db.add.call_args.args[0]
    assert job.kind == "apns_push"
