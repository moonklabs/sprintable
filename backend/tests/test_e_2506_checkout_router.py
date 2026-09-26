"""#2506 — POST /api/v2/org-subscriptions/checkout 엔드포인트. 인증/권한/에러매핑.

story #4335 — checkout · change-tier는 결제 시도를 만들고 곧바로 202(처리 중) · 결과는 `GET /attempts/{id}`. 새 시도면 응답 뒤
작업(`run_attempt`)을 한 번 걸고, 이미 있던 시도(같은 id)면 새 작업 없이 그 상태(끝났으면 200)."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient


def _auth_ctx(user_id):
    ctx = MagicMock()
    ctx.user_id = str(user_id)
    return ctx


def _sub(*, org_id, status="active"):
    s = MagicMock()
    s.org_id = org_id
    s.tier = "team"
    s.billing_cycle = "monthly"
    s.status = status
    s.current_period_start = datetime(2026, 8, 7, tzinfo=timezone.utc)
    s.current_period_end = datetime(2026, 9, 7, tzinfo=timezone.utc)
    # story #2881 — CheckoutResponse가 이 필드들을 읽는다(pending 하향 노출).
    s.pending_tier = None
    s.pending_offering_version_id = None
    s.pending_change_apply_at = None
    return s


def _checkout_enabled():
    """story #2728 — 이 파일의 테스트들은 org-admin/checkout_subscription 분기 자체를
    검증 대상으로 삼는다(platform_settings 게이트는 별도 test_2728 파일에서 전담 검증) —
    여기서는 게이트를 통과시켜 원래 테스트 취지를 그대로 살린다."""
    settings = MagicMock()
    settings.billing_checkout_enabled = True
    return patch(
        "app.routers.org_subscription_checkout.get_platform_settings",
        new=AsyncMock(return_value=settings),
    )


@pytest.fixture
def _app_client():
    from app.main import app
    from app.dependencies.auth import get_current_user, get_verified_org_id_no_project_gate
    from app.dependencies.database import get_db
    from tests.conftest import override_db_and_read

    org_id = uuid.uuid4()
    user_id = uuid.uuid4()

    async def _override_get_db():
        yield AsyncMock()

    override_db_and_read(app, _override_get_db)
    app.dependency_overrides[get_current_user] = lambda: _auth_ctx(user_id)
    app.dependency_overrides[get_verified_org_id_no_project_gate] = lambda: org_id
    try:
        yield TestClient(app), org_id
    finally:
        app.dependency_overrides.clear()


ATTEMPT_ID = "11111111-1111-4111-8111-111111111111"
CHECKOUT_BODY = {"attempt_id": ATTEMPT_ID, "auth_key": "ak", "tier": "team", "billing_cycle": "monthly"}


def _attempt(*, org_id, status="processing", kind="checkout", reason=None, reauth=False):
    a = MagicMock()
    a.id = uuid.UUID(ATTEMPT_ID)
    a.org_id = org_id
    a.kind = kind
    a.status = status
    a.tier = "team"
    a.billing_cycle = "monthly"
    a.reason = reason
    a.reauth_required = reauth
    a.refund_status = None
    return a


def _start(result=None, *, side_effect=None, kind="checkout"):
    name = "start_checkout_attempt" if kind == "checkout" else "start_change_tier_attempt"
    return patch(f"app.routers.org_subscription_checkout.attempts.{name}", new=AsyncMock(return_value=result, side_effect=side_effect))


def _admin(ok=True):
    return patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=ok))


def test_checkout_returns_403_when_not_org_admin(_app_client):
    client, org_id = _app_client
    with _checkout_enabled(), _admin(False):
        resp = client.post("/api/v2/org-subscriptions/checkout", json=CHECKOUT_BODY)
    assert resp.status_code == 403


def test_new_checkout_attempt_is_202_processing_and_schedules_one_background_run_with_the_auth_key(_app_client):
    client, org_id = _app_client
    token = uuid.uuid4()
    run = AsyncMock()
    with _checkout_enabled(), _admin(), _start((_attempt(org_id=org_id), token)), \
         patch("app.routers.org_subscription_checkout.attempts.run_attempt", new=run):
        resp = client.post("/api/v2/org-subscriptions/checkout", json=CHECKOUT_BODY)
    assert resp.status_code == 202
    body = resp.json()
    assert (body["attempt_id"], body["status"], body["subscription"]) == (ATTEMPT_ID, "processing", None)
    run.assert_awaited_once_with(uuid.UUID(ATTEMPT_ID), token, auth_key="ak")


def test_same_attempt_id_again_starts_no_work_and_returns_the_finished_state_with_200(_app_client):
    """같은 시도 id(새로고침 · 끊긴 뒤 재요청) — 토큰 없음 → 응답 뒤 작업 0 · 끝난 시도면 200 + 구독 상태."""
    from app.main import app
    from tests.conftest import override_db_and_read

    client, org_id = _app_client
    session = AsyncMock()
    result = MagicMock()
    result.scalar_one_or_none.return_value = _sub(org_id=org_id, status="active")
    session.execute = AsyncMock(return_value=result)

    async def _db():
        yield session

    override_db_and_read(app, _db)
    run = AsyncMock()
    with _checkout_enabled(), _admin(), _start((_attempt(org_id=org_id, status="succeeded"), None)), \
         patch("app.routers.org_subscription_checkout.attempts.run_attempt", new=run):
        resp = client.post("/api/v2/org-subscriptions/checkout", json=CHECKOUT_BODY)
    assert resp.status_code == 200
    assert resp.json()["status"] == "succeeded" and resp.json()["subscription"]["status"] == "active"
    run.assert_not_awaited()


def test_checkout_attempt_id_is_required(_app_client):
    client, _ = _app_client
    body = {k: v for k, v in CHECKOUT_BODY.items() if k != "attempt_id"}
    with _checkout_enabled(), _admin():
        assert client.post("/api/v2/org-subscriptions/checkout", json=body).status_code == 422


def test_checkout_returns_400_when_active_paid_subscription_exists(_app_client):
    """⛔P0(2026-08-21, story a8fec107) — 활성 유료 org의 checkout 재진입은 400·문구에
    change-tier 경로 명시(틀린 복구 행동 유도 방지)."""
    from app.services.org_subscription_checkout import ActivePaidSubscriptionExists

    client, org_id = _app_client
    with _checkout_enabled(), _admin(), _start(side_effect=ActivePaidSubscriptionExists(
        f"org_id={org_id}는 이미 활성 유료 구독(tier='business')입니다 — 플랜 변경은 POST /api/v2/org-subscriptions/change-tier를 쓰세요."
    )):
        resp = client.post("/api/v2/org-subscriptions/checkout", json=CHECKOUT_BODY)
    assert resp.status_code == 400
    assert "change-tier" in resp.json()["error"]["message"]


def test_checkout_returns_409_when_another_payment_is_in_progress(_app_client):
    from app.services.org_subscription_checkout import CheckoutInProgress

    client, _ = _app_client
    with _checkout_enabled(), _admin(), _start(side_effect=CheckoutInProgress("busy")):
        assert client.post("/api/v2/org-subscriptions/checkout", json=CHECKOUT_BODY).status_code == 409


def test_checkout_returns_500_on_internal_catalog_gap(_app_client):
    from app.services.org_subscription_checkout import CheckoutError

    client, _ = _app_client
    with _checkout_enabled(), _admin(), _start(side_effect=CheckoutError("offering_version not found")):
        assert client.post("/api/v2/org-subscriptions/checkout", json=CHECKOUT_BODY).status_code == 500


def test_attempt_id_of_another_org_is_404(_app_client):
    from app.services.billing_payment_attempt import AttemptNotFound

    client, _ = _app_client
    with _checkout_enabled(), _admin(), _start(side_effect=AttemptNotFound(ATTEMPT_ID)):
        assert client.post("/api/v2/org-subscriptions/checkout", json=CHECKOUT_BODY).status_code == 404


def test_checkout_rejects_invalid_tier_with_422(_app_client):
    """free 등 Literal 밖 값 — pydantic이 서비스 계층 도달 前에 이미 거른다."""
    client, org_id = _app_client
    resp = client.post("/api/v2/org-subscriptions/checkout", json={**CHECKOUT_BODY, "tier": "free"})
    assert resp.status_code == 422


def test_checkout_returns_403_when_billing_checkout_disabled(_app_client):
    """story #2728(선생님 결정②) — platform_settings.billing_checkout_enabled=false면
    org-admin 권한과 무관하게 무조건 403(서버측 전면 차단, gate가 org-admin 체크보다
    먼저 — is_org_owner_or_admin이 아예 호출 안 됨을 mock 미설정으로 확認)."""
    client, org_id = _app_client
    settings = MagicMock()
    settings.billing_checkout_enabled = False
    with patch(
        "app.routers.org_subscription_checkout.get_platform_settings",
        new=AsyncMock(return_value=settings),
    ):
        resp = client.post("/api/v2/org-subscriptions/checkout", json=CHECKOUT_BODY)
    assert resp.status_code == 403


def test_checkout_requires_auth():
    from app.main import app

    with TestClient(app) as client:
        resp = client.post("/api/v2/org-subscriptions/checkout", json=CHECKOUT_BODY)
    assert resp.status_code == 401


# ── change-tier · 상태 조회 ───────────────────────────────────────────────────────────────────────────

def test_new_change_tier_attempt_is_202_and_schedules_a_background_run_without_auth_key(_app_client):
    client, org_id = _app_client
    token = uuid.uuid4()
    run = AsyncMock()
    with _checkout_enabled(), _admin(), _start((_attempt(org_id=org_id, kind="change_tier"), token), kind="change_tier"), \
         patch("app.routers.org_subscription_checkout.attempts.run_attempt", new=run):
        resp = client.post("/api/v2/org-subscriptions/change-tier", json={"attempt_id": ATTEMPT_ID, "new_tier": "business"})
    assert resp.status_code == 202 and resp.json()["kind"] == "change_tier"
    run.assert_awaited_once_with(uuid.UUID(ATTEMPT_ID), token)


def test_change_tier_policy_violation_is_400_before_any_attempt(_app_client):
    from app.services.org_subscription_tier_change import TierChangeError

    client, _ = _app_client
    with _checkout_enabled(), _admin(), _start(side_effect=TierChangeError("하향"), kind="change_tier"):
        resp = client.post("/api/v2/org-subscriptions/change-tier", json={"attempt_id": ATTEMPT_ID, "new_tier": "starter"})
    assert resp.status_code == 400


def test_get_attempt_reconciles_and_returns_its_state(_app_client):
    client, org_id = _app_client
    processing = _attempt(org_id=org_id, status="processing")
    reconcile = AsyncMock(return_value=processing)
    with _admin(), patch("app.routers.org_subscription_checkout.attempts.get_attempt", new=AsyncMock(return_value=processing)), \
         patch("app.routers.org_subscription_checkout.attempts.reconcile_attempt", new=reconcile):
        resp = client.get(f"/api/v2/org-subscriptions/attempts/{ATTEMPT_ID}")
    assert resp.status_code == 200 and resp.json()["status"] == "processing"
    reconcile.assert_awaited_once()


def test_get_attempt_of_another_org_is_404_and_does_not_reconcile(_app_client):
    from app.services.billing_payment_attempt import AttemptNotFound

    client, _ = _app_client
    reconcile = AsyncMock()
    with _admin(), patch("app.routers.org_subscription_checkout.attempts.get_attempt", new=AsyncMock(side_effect=AttemptNotFound("x"))), \
         patch("app.routers.org_subscription_checkout.attempts.reconcile_attempt", new=reconcile):
        resp = client.get(f"/api/v2/org-subscriptions/attempts/{ATTEMPT_ID}")
    assert resp.status_code == 404
    reconcile.assert_not_awaited()
