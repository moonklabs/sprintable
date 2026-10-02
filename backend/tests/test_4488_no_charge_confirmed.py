"""story #4488 — what the billing screen may say about a charge for an attempt that ended without one (declined · failed):
`confirmed` only on a recorded proof (`no_charge_proven_at`), `checking` while the 24 h recheck runs, `unresolved` once it
closed without a proof. No DB: the rule is a function of the row."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services.billing_payment_attempt import no_charge_state

NOW = datetime(2026, 10, 2, 3, 30, tzinfo=timezone.utc)


def _attempt(status: str, *, proven: bool, rechecking: bool):
    return SimpleNamespace(status=status, no_charge_proven_at=NOW if proven else None,
                           next_check_at=(NOW + timedelta(hours=1)) if rechecking else None)


@pytest.mark.parametrize("status", ["declined", "failed"])
def test_a_recorded_proof_is_confirmed(status):
    assert no_charge_state(_attempt(status, proven=True, rechecking=False)) == "confirmed"


@pytest.mark.parametrize("status", ["declined", "failed"])
def test_no_proof_while_the_recheck_runs_is_checking(status):
    assert no_charge_state(_attempt(status, proven=False, rechecking=True)) == "checking"


@pytest.mark.parametrize("status", ["declined", "failed"])
def test_no_proof_and_no_recheck_left_is_unresolved(status):
    assert no_charge_state(_attempt(status, proven=False, rechecking=False)) == "unresolved"


@pytest.mark.parametrize("status", ["processing", "succeeded", "voided"])
def test_other_states_say_nothing_about_a_charge(status):
    assert no_charge_state(_attempt(status, proven=True, rechecking=False)) is None


def test_the_not_found_body_the_web_reads_is_what_the_handler_really_sends():
    """story #4488 (Kadir 4901 ②) — the web tells «no such attempt» (nothing started · nothing charged) from any other 404 by
    this exact body. It is rendered here by the real exception handler from the attempt router's own HTTPException, and the
    web tests read the same file — a mock shape can no longer drift from the contract."""
    import asyncio
    import json
    import re
    from pathlib import Path

    from fastapi import HTTPException
    from starlette.requests import Request

    from app.main import http_exception_handler

    backend = Path(__file__).resolve().parent.parent
    router = (backend / "app" / "routers" / "org_subscription_checkout.py").read_text(encoding="utf-8")
    raised = set(re.findall(r'HTTPException\(status_code=404, detail="([^"]+)"\) from exc\n', router))
    assert raised == {"payment attempt not found"}, raised  # the router's AttemptNotFound 404s all say this

    request = Request({"type": "http", "method": "GET", "path": "/api/v2/org-subscriptions/attempts/x", "headers": []})
    response = asyncio.run(http_exception_handler(request, HTTPException(status_code=404, detail="payment attempt not found")))
    shared = json.loads((backend.parent / "contracts" / "billing-attempt-not-found.json").read_text(encoding="utf-8"))
    assert response.status_code == 404
    assert json.loads(response.body) == shared
