"""story #4488 — «청구된 금액은 없어요» only when the server has proven it: an attempt that ended without a charge (declined ·
failed) and either never started a charge or has passed the recheck window (`RECHECK_WINDOW` — a late Toss DONE can still
turn up inside it). No DB: the rule is a function of the row."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services.billing_payment_attempt import RECHECK_WINDOW, no_charge_confirmed

NOW = datetime(2026, 10, 2, 3, 30, tzinfo=timezone.utc)


def _attempt(status: str, *, started: bool, finished_ago: timedelta | None):
    return SimpleNamespace(
        status=status,
        charge_started_at=(NOW - timedelta(days=2)) if started else None,
        finished_at=(NOW - finished_ago) if finished_ago is not None else None,
    )


@pytest.mark.parametrize("status", ["declined", "failed"])
def test_ended_without_ever_starting_a_charge_is_proven(status):
    assert no_charge_confirmed(_attempt(status, started=False, finished_ago=timedelta(minutes=1)), NOW) is True


@pytest.mark.parametrize("status", ["declined", "failed"])
def test_a_started_charge_is_not_proven_inside_the_recheck_window(status):
    assert no_charge_confirmed(_attempt(status, started=True, finished_ago=RECHECK_WINDOW - timedelta(seconds=1)), NOW) is False


@pytest.mark.parametrize("status", ["declined", "failed"])
def test_a_started_charge_is_proven_once_the_window_has_passed(status):
    assert no_charge_confirmed(_attempt(status, started=True, finished_ago=RECHECK_WINDOW), NOW) is True


def test_a_started_charge_without_an_end_time_is_not_proven():
    assert no_charge_confirmed(_attempt("failed", started=True, finished_ago=None), NOW) is False


@pytest.mark.parametrize("status", ["processing", "succeeded", "voided"])
def test_other_states_never_say_nothing_was_charged(status):
    assert no_charge_confirmed(_attempt(status, started=False, finished_ago=timedelta(days=3)), NOW) is False


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
