"""#2512 — Toss 위젯 오픈 前 customerKey 발급/조회. 미르코 FE 연동 발견(2026-08-07):
위젯은 authKey보다 먼저 customerKey가 필요하다."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _exec_result(scalar_value):
    r = MagicMock()
    r.scalar_one_or_none.return_value = scalar_value
    r.scalar_one.return_value = scalar_value
    return r


# ─── ensure_customer_key ─────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_ensure_customer_key_creates_placeholder_when_none_exists():
    from app.services.org_billing_key import ensure_customer_key

    org_id = uuid.uuid4()
    session = AsyncMock()
    insert_result = MagicMock()
    insert_result.rowcount = 1
    session.execute = AsyncMock(side_effect=[_exec_result(None), insert_result])
    session.commit = AsyncMock()

    customer_key = await ensure_customer_key(session, org_id=org_id)

    assert customer_key.startswith("org-")
    session.commit.assert_awaited_once()

    insert_call = session.execute.call_args_list[1]
    compiled = insert_call.args[0].compile().params
    assert compiled["org_id"] == org_id
    assert compiled["status"] == "awaiting_auth"
    assert compiled["customer_key"] == customer_key


@pytest.mark.anyio
async def test_ensure_customer_key_returns_existing_without_insert():
    from app.services.org_billing_key import ensure_customer_key

    org_id = uuid.uuid4()
    session = AsyncMock()
    session.execute = AsyncMock(return_value=_exec_result("org-already-exists"))

    customer_key = await ensure_customer_key(session, org_id=org_id)

    assert customer_key == "org-already-exists"
    assert session.execute.await_count == 1  # insert 시도 자체를 안 함
    session.commit.assert_not_awaited()


@pytest.mark.anyio
async def test_ensure_customer_key_is_idempotent_returns_same_key_twice():
    from app.services.org_billing_key import ensure_customer_key

    org_id = uuid.uuid4()
    session = AsyncMock()
    insert_result = MagicMock()
    insert_result.rowcount = 1
    session.execute = AsyncMock(side_effect=[_exec_result(None), insert_result])
    session.commit = AsyncMock()
    first_key = await ensure_customer_key(session, org_id=org_id)

    session.execute = AsyncMock(return_value=_exec_result(first_key))
    second_key = await ensure_customer_key(session, org_id=org_id)

    assert first_key == second_key


@pytest.mark.anyio
async def test_ensure_customer_key_handles_concurrent_race_loss():
    """동시에 다른 요청이 먼저 placeholder를 만든 경우(ON CONFLICT DO NOTHING이 rowcount=0)
    — 그 행의 customer_key를 재조회해 반환(내가 만들려던 값 버림)."""
    from app.services.org_billing_key import ensure_customer_key

    org_id = uuid.uuid4()
    session = AsyncMock()
    lost_race_result = MagicMock()
    lost_race_result.rowcount = 0
    session.execute = AsyncMock(side_effect=[
        _exec_result(None), lost_race_result, _exec_result("org-winner-of-race"),
    ])
    session.commit = AsyncMock()

    customer_key = await ensure_customer_key(session, org_id=org_id)

    assert customer_key == "org-winner-of-race"


@pytest.mark.anyio
async def test_issue_billing_key_reuses_placeholder_customer_key():
    """issue_billing_key()가 ensure_customer_key()가 만든 placeholder 행을 찾아 실
    빌링키로 덮어쓰는지 — 기존 재사용 로직(existing.customer_key)이 placeholder에도
    그대로 통하는지 회귀 실증."""
    from app.services.org_billing_key import issue_billing_key

    org_id = uuid.uuid4()
    placeholder = MagicMock()
    placeholder.customer_key = "org-placeholder-key"

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=[_exec_result(placeholder), MagicMock(), _exec_result(MagicMock())])
    session.commit = AsyncMock()

    toss_response = {
        "billingKey": "real-billing-key",
        "card": {"issuerCode": "61", "number": "1234****", "cardType": "신용", "ownerType": "개인"},
        "authenticatedAt": "2026-08-07T00:00:00+09:00",
    }

    with patch("app.services.org_billing_key.TossAdapter") as MockAdapter, \
         patch("app.services.org_billing_key.encrypt_billing_key", return_value="encrypted-value"), \
         patch("app.services.org_billing_key.ensure_configured"):
        MockAdapter.return_value.create_billing_key = AsyncMock(return_value=toss_response)
        await issue_billing_key(session, org_id=org_id, auth_key="widget-auth-key")

    create_call_kwargs = MockAdapter.return_value.create_billing_key.await_args.kwargs
    assert create_call_kwargs["customer_key"] == "org-placeholder-key"  # placeholder 재사용

    upsert_call = session.execute.call_args_list[1]
    compiled = upsert_call.args[0].compile().params
    assert compiled["status"] == "active"
    assert compiled["encrypted_billing_key"] == "encrypted-value"


# ─── router ───────────────────────────────────────────────────────────────

def _auth_ctx(user_id):
    ctx = MagicMock()
    ctx.user_id = str(user_id)
    return ctx


@pytest.fixture
def _app_client():
    from fastapi.testclient import TestClient
    from app.main import app
    from app.dependencies.auth import get_current_user, get_verified_org_id_no_project_gate
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


def test_customer_key_endpoint_returns_403_when_not_org_admin(_app_client):
    client, org_id = _app_client
    with patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=False)):
        resp = client.post("/api/v2/org-billing-keys/customer-key")
    assert resp.status_code == 403


def test_customer_key_endpoint_returns_200_with_key(_app_client):
    client, org_id = _app_client
    with patch("app.services.project_auth.is_org_owner_or_admin", new=AsyncMock(return_value=True)), \
         patch("app.routers.billing_keys.ensure_customer_key", new=AsyncMock(return_value="org-abc123")):
        resp = client.post("/api/v2/org-billing-keys/customer-key")
    assert resp.status_code == 200
    assert resp.json()["customer_key"] == "org-abc123"


def test_customer_key_endpoint_requires_auth():
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as client:
        resp = client.post("/api/v2/org-billing-keys/customer-key")
    assert resp.status_code == 401
