"""story #4489 — what the web reads when a new payment is refused (contracts/billing-payment-unresolved.json: the status and
`error.code` of the real envelope), and that the refusal opens only where the operator's resolve actions do (PO 04:11Z: a
refusal with no way out is a dead end). No DB."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.routers import admin_billing
from app.services import billing_payment_attempt as svc
from tests.test_e_2506_checkout_router import CHECKOUT_BODY, _admin, _app_client, _checkout_enabled, _start  # noqa: F401

_CONTRACT = json.loads((Path(__file__).resolve().parents[2] / "contracts" / "billing-payment-unresolved.json").read_text())


@pytest.mark.parametrize("kind, path, body", [
    ("checkout", "/api/v2/org-subscriptions/checkout", CHECKOUT_BODY),
    ("change_tier", "/api/v2/org-subscriptions/change-tier", {"attempt_id": CHECKOUT_BODY["attempt_id"], "new_tier": "team"}),
])
def test_a_refused_start_answers_the_contract_the_web_reads(_app_client, kind, path, body):
    client, _org = _app_client
    with _checkout_enabled(), _admin(True), _start(side_effect=svc.PaymentUnresolved("org has an unresolved attempt"), kind=kind):
        resp = client.post(path, json=body)
    assert resp.status_code == _CONTRACT["status"]
    assert resp.json()["error"]["code"] == _CONTRACT["code"]


@pytest.fixture
def _env():
    orig = settings.deploy_env
    yield
    settings.deploy_env = orig


@pytest.mark.parametrize("env", ["prod", "dev", "develop"])
def test_the_refusal_is_on_exactly_where_the_resolve_actions_are_open(_env, env):
    settings.deploy_env = env
    try:
        admin_billing._reject_prod()
        resolve_open = True
    except HTTPException:
        resolve_open = False
    assert svc.operator_resolve_open() == resolve_open
