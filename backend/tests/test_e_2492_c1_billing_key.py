"""#2492(C1) — org_billing_keys 스키마 + customerKey 발급 + TossAdapter.create_billing_key +
암호화 유틸 + 발급 엔드포인트. 결제 어댑터 계층(#2478 B) 위에 Toss 실 구현을 얹는다."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.conftest import override_db_and_read


# ─── TossAdapter: 미구현 메서드는 NotImplementedError(C1 스코프 밖) ─────────

@pytest.mark.anyio
@pytest.mark.parametrize(
    "method_name,kwargs",
    [
        ("create_customer", {}),
        ("create_checkout", {}),
        # charge는 #2493(C2)로 실 구현됨 — test_e_2493_c2_charge_ledger.py로 이동.
        # refund/verify_webhook은 #2495(C4)로 실 구현됨 — test_e_2495_c4_refund_reconciliation.py로 이동.
        ("open_portal", {}),
        ("cancel", {}),
    ],
)
async def test_toss_adapter_unimplemented_methods_raise_explicitly(method_name, kwargs):
    from app.services.payment.toss_adapter import TossAdapter

    adapter = TossAdapter()
    method = getattr(adapter, method_name)
    with pytest.raises(NotImplementedError):
        await method(**kwargs)


# ─── TossAdapter.create_billing_key — 실 HTTP 파이프라인 ───────────────────

@pytest.mark.anyio
async def test_create_billing_key_no_secret_raises_before_any_http_call():
    """PolarAdapter의 "토큰 없으면 mock"과 다르게 결제는 fail-closed — 시크릿 미설정 시
    HTTP 호출 자체를 안 한다."""
    from app.services.payment.toss_adapter import TossAdapter

    with patch("app.services.payment.toss_adapter.settings") as mock_settings:
        mock_settings.toss_payments_secret_key = ""
        adapter = TossAdapter()
        with pytest.raises(RuntimeError, match="TOSS_PAYMENTS_SECRET_KEY"):
            await adapter.create_billing_key(auth_key="auth_x", customer_key="cust_x")


@pytest.mark.anyio
async def test_create_billing_key_success():
    from app.services.payment.toss_adapter import TossAdapter

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {
        "mId": "merchant_1",
        "customerKey": "cust_x",
        "authenticatedAt": "2026-08-07T00:00:00+09:00",
        "method": "카드",
        "billingKey": "billing_plaintext_token",
        "card": {
            "issuerCode": "61", "acquirerCode": "31", "number": "1234********5678",
            "cardType": "신용", "ownerType": "개인",
        },
    }

    with patch("app.services.payment.toss_adapter.settings") as mock_settings:
        mock_settings.toss_payments_secret_key = "test_sk_dummy"
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value.post = AsyncMock(return_value=mock_resp)
        with patch("httpx.AsyncClient", return_value=mock_client):
            adapter = TossAdapter()
            result = await adapter.create_billing_key(auth_key="auth_x", customer_key="cust_x")

    assert result["billingKey"] == "billing_plaintext_token"
    assert result["card"]["number"] == "1234********5678"
    # 실 요청 바디가 authKey/customerKey를 정확히 실었는지.
    call_kwargs = mock_client.__aenter__.return_value.post.call_args.kwargs
    assert call_kwargs["json"] == {"authKey": "auth_x", "customerKey": "cust_x"}
    assert call_kwargs["headers"]["Authorization"].startswith("Basic ")


@pytest.mark.anyio
async def test_create_billing_key_error_status_raises_runtime_error():
    from app.services.payment.toss_adapter import TossAdapter

    mock_resp = MagicMock()
    mock_resp.status_code = 400
    mock_resp.headers = {"content-type": "application/json"}
    mock_resp.json.return_value = {"code": "INVALID_AUTH_KEY", "message": "..."}

    with patch("app.services.payment.toss_adapter.settings") as mock_settings:
        mock_settings.toss_payments_secret_key = "test_sk_dummy"
        mock_client = AsyncMock()
        mock_client.__aenter__.return_value.post = AsyncMock(return_value=mock_resp)
        with patch("httpx.AsyncClient", return_value=mock_client):
            adapter = TossAdapter()
            with pytest.raises(RuntimeError, match="INVALID_AUTH_KEY"):
                await adapter.create_billing_key(auth_key="bad", customer_key="cust_x")


# ─── billing_key_crypto: MultiFernet 암복호화 + 회전 ────────────────────────

def _fresh_crypto_module_with_keys(monkeypatch, keys_csv: str):
    """모듈을 매 테스트 새로 로드 + lru_cache 초기화(설정값 격리)."""
    import importlib

    import app.core.config as config_module
    monkeypatch.setattr(config_module.settings, "org_billing_key_encryption_key", keys_csv)
    import app.services.billing_key_crypto as crypto_module
    importlib.reload(crypto_module)
    return crypto_module


def test_billing_key_crypto_roundtrip(monkeypatch):
    from cryptography.fernet import Fernet

    key = Fernet.generate_key().decode()
    crypto = _fresh_crypto_module_with_keys(monkeypatch, key)

    token = crypto.encrypt_billing_key("billing_plaintext_token")
    assert token != "billing_plaintext_token"
    assert crypto.decrypt_billing_key(token) == "billing_plaintext_token"


def test_billing_key_crypto_rotation_old_key_still_decrypts(monkeypatch):
    """PO 가드① — MultiFernet: 옛 키로 암호화된 값이 새 키가 앞에 추가된 뒤에도 복호된다."""
    from cryptography.fernet import Fernet

    old_key = Fernet.generate_key().decode()
    crypto_old = _fresh_crypto_module_with_keys(monkeypatch, old_key)
    token = crypto_old.encrypt_billing_key("secret_v1")

    new_key = Fernet.generate_key().decode()
    crypto_rotated = _fresh_crypto_module_with_keys(monkeypatch, f"{new_key},{old_key}")
    assert crypto_rotated.decrypt_billing_key(token) == "secret_v1"

    # 회전 후 신규 암호화는 새 키(맨 앞)를 쓴다 — 옛 키만 남기고 새 키를 빼면 복호 실패해야.
    new_token = crypto_rotated.encrypt_billing_key("secret_v2")
    crypto_new_only = _fresh_crypto_module_with_keys(monkeypatch, new_key)
    assert crypto_new_only.decrypt_billing_key(new_token) == "secret_v2"


def test_billing_key_crypto_not_configured_raises(monkeypatch):
    crypto = _fresh_crypto_module_with_keys(monkeypatch, "")
    with pytest.raises(crypto.BillingKeyEncryptionNotConfigured):
        crypto.encrypt_billing_key("x")


def test_ensure_configured_catches_malformed_key_not_just_missing(monkeypatch):
    """PO 재지적(#2882 C2 리뷰) — 「있지만 malformed」 키(Fernet이 기대하는 base64 형식이
    아님)도 ensure_configured()가 실제 MultiFernet 구성까지 해봐서 이 시점에 잡아야 한다
    (문자열 존재 여부만 보는 얕은 체크였으면 여길 통과하고 Toss 호출 後에야 터졌을 것)."""
    crypto = _fresh_crypto_module_with_keys(monkeypatch, "not-a-valid-fernet-key")
    with pytest.raises(ValueError, match="Fernet key"):
        crypto.ensure_configured()


# ─── org_billing_key.issue_billing_key — 오케스트레이션 ────────────────────

@pytest.mark.anyio
async def test_issue_billing_key_new_org_generates_customer_key_and_persists(monkeypatch):
    from app.models.org_billing_key import OrgBillingKey
    from app.services import org_billing_key as svc

    org_id = uuid.uuid4()
    session = AsyncMock()
    persisted = MagicMock()
    persisted.scalar_one.return_value = MagicMock(spec=OrgBillingKey)
    session.execute = AsyncMock(side_effect=[MagicMock(), persisted])
    session.commit = AsyncMock()

    monkeypatch.setattr(svc, "ensure_configured", MagicMock())
    # #2512 카디르 fix — issue_billing_key는 이제 ensure_customer_key()에 위임한다
    # (크로스-커넥션 레이스 근본 fix, #2892 리뷰).
    monkeypatch.setattr(svc, "ensure_customer_key", AsyncMock(return_value="org-generated-key"))
    monkeypatch.setattr(
        svc.TossAdapter, "create_billing_key",
        AsyncMock(return_value={
            "billingKey": "plaintext_bk", "authenticatedAt": "2026-08-07T00:00:00+09:00",
            "card": {"issuerCode": "61", "number": "1234********5678", "cardType": "신용", "ownerType": "개인"},
        }),
    )
    monkeypatch.setattr(svc, "encrypt_billing_key", MagicMock(return_value="enc-token"))

    result = await svc.issue_billing_key(session, org_id=org_id, auth_key="auth_x")

    assert result is not None
    insert_call = session.execute.call_args_list[0]
    compiled_params = insert_call.args[0].compile().params
    assert compiled_params["org_id"] == org_id
    assert compiled_params["customer_key"] == "org-generated-key"
    assert compiled_params["encrypted_billing_key"] == "enc-token"
    assert compiled_params["status"] == "active"


@pytest.mark.anyio
async def test_issue_billing_key_reuses_existing_customer_key(monkeypatch):
    """재발급(카드 교체) — 기존 행이 있으면 새 customerKey를 만들지 않고 재사용한다.
    #2512 카디르 fix — 이 재사용 판단은 이제 ensure_customer_key()가 진다(issue_billing_key
    는 스스로 SELECT하지 않는다, #2892 리뷰 크로스-커넥션 레이스 fix)."""
    from app.services import org_billing_key as svc

    org_id = uuid.uuid4()
    session = AsyncMock()
    persisted = MagicMock()
    session.execute = AsyncMock(side_effect=[MagicMock(), persisted])
    session.commit = AsyncMock()

    monkeypatch.setattr(svc, "ensure_configured", MagicMock())
    monkeypatch.setattr(svc, "ensure_customer_key", AsyncMock(return_value="org-existing-key"))
    create_billing_key_mock = AsyncMock(return_value={
        "billingKey": "plaintext_bk2", "authenticatedAt": "2026-08-07T00:00:00+09:00", "card": {},
    })
    monkeypatch.setattr(svc.TossAdapter, "create_billing_key", create_billing_key_mock)
    monkeypatch.setattr(svc, "encrypt_billing_key", MagicMock(return_value="enc-token2"))

    await svc.issue_billing_key(session, org_id=org_id, auth_key="auth_y")

    create_billing_key_mock.assert_awaited_once_with(auth_key="auth_y", customer_key="org-existing-key")


@pytest.mark.anyio
async def test_issue_billing_key_checks_crypto_before_consuming_auth_key(monkeypatch):
    """PO nit①(#2880 리뷰) 회귀 고정 — 암호화 키 미설정이면 1회용 authKey를 소모하는
    create_billing_key 호출 자체를 하지 않는다(호출 순서 증명)."""
    from app.services import org_billing_key as svc
    from app.services.billing_key_crypto import BillingKeyEncryptionNotConfigured

    session = AsyncMock()
    monkeypatch.setattr(
        svc, "ensure_configured", MagicMock(side_effect=BillingKeyEncryptionNotConfigured("x"))
    )
    create_billing_key_mock = AsyncMock()
    monkeypatch.setattr(svc.TossAdapter, "create_billing_key", create_billing_key_mock)

    with pytest.raises(BillingKeyEncryptionNotConfigured):
        await svc.issue_billing_key(session, org_id=uuid.uuid4(), auth_key="auth_never_used")

    create_billing_key_mock.assert_not_awaited()
    session.execute.assert_not_awaited()


@pytest.mark.anyio
async def test_issue_billing_key_reissue_bumps_updated_at(monkeypatch):
    """PO nit②(#2880 리뷰) 회귀 고정 — ON CONFLICT DO UPDATE 재발급 경로도 updated_at을
    명시로 갱신한다(ORM onupdate는 raw INSERT..ON CONFLICT를 안 거쳐 무력했던 것)."""
    from app.services import org_billing_key as svc

    org_id = uuid.uuid4()
    existing_row = MagicMock()
    existing_row.customer_key = "org-existing-key"
    session = AsyncMock()
    existing_result = MagicMock()
    existing_result.scalar_one_or_none.return_value = existing_row
    persisted = MagicMock()
    session.execute = AsyncMock(side_effect=[existing_result, MagicMock(), persisted])
    session.commit = AsyncMock()

    monkeypatch.setattr(svc, "ensure_configured", MagicMock())
    monkeypatch.setattr(
        svc.TossAdapter, "create_billing_key",
        AsyncMock(return_value={"billingKey": "bk3", "authenticatedAt": "2026-08-07T00:00:00+09:00", "card": {}}),
    )
    monkeypatch.setattr(svc, "encrypt_billing_key", MagicMock(return_value="enc-token3"))

    await svc.issue_billing_key(session, org_id=org_id, auth_key="auth_z")

    insert_call = session.execute.call_args_list[1]
    stmt = insert_call.args[0]
    on_conflict_set = stmt._post_values_clause.update_values_to_set
    set_columns = {c if isinstance(c, str) else c.name for c, _ in on_conflict_set}
    assert "updated_at" in set_columns


# ─── POST /api/v2/org-billing-keys — 엔드포인트(양성/음성/unauth/X-Project-Id 무관) ──

@pytest.mark.anyio
async def test_create_billing_key_endpoint_ignores_inaccessible_x_project_id_when_org_admin(
    test_client, mock_session, monkeypatch, org_id
):
    import app.routers.billing_keys as router_module
    import app.services.project_auth as project_auth

    monkeypatch.setattr(project_auth, "is_org_owner_or_admin", AsyncMock(return_value=True))
    fake_key = MagicMock()
    fake_key.org_id = org_id
    fake_key.status = "active"
    fake_key.card_issuer_code = "61"
    fake_key.card_number_masked = "1234********5678"
    fake_key.card_type = "신용"
    monkeypatch.setattr(router_module, "issue_billing_key", AsyncMock(return_value=fake_key))

    inaccessible_project_id = str(uuid.uuid4())
    resp = await test_client.post(
        "/api/v2/org-billing-keys",
        json={"auth_key": "auth_x"},
        headers={"X-Project-Id": inaccessible_project_id},
    )
    assert resp.status_code == 201
    assert resp.json()["status"] == "active"


@pytest.mark.anyio
async def test_create_billing_key_endpoint_still_403_for_genuine_non_admin(
    test_client, mock_session, monkeypatch
):
    import app.services.project_auth as project_auth

    monkeypatch.setattr(project_auth, "is_org_owner_or_admin", AsyncMock(return_value=False))

    resp = await test_client.post("/api/v2/org-billing-keys", json={"auth_key": "auth_x"})
    assert resp.status_code == 403
    assert "admin" in resp.json()["error"]["message"].lower()


@pytest.mark.anyio
async def test_create_billing_key_endpoint_still_401_without_auth(mock_session):
    from httpx import ASGITransport, AsyncClient

    from app.main import app

    async def _override_db():
        yield mock_session

    override_db_and_read(app, _override_db)
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.post("/api/v2/org-billing-keys", json={"auth_key": "auth_x"})
    finally:
        app.dependency_overrides.clear()

    assert resp.status_code == 401
