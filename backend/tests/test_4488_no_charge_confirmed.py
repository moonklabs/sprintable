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
