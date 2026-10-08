"""story #4641 (design 4641 · Kadir's lens conditional pass) — a permission widening a person made at the terminal, on the session.

No database: the closed lists, the report's rules, the newer-wins row rule and the reader's keys. The CHECK strings in 0449 are the
same lists (one changed alone → RED)."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import get_args

import pytest
from pydantic import ValidationError

from app.models.desktop_relay import SESSION_WIDENED_MODES
from app.services.desktop_relay import WidenedMode, SessionReport, WIDENED_MAX_AHEAD, _set_widened, widened_view

import uuid

NOW = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)


def _report(**kw) -> SessionReport:
    base = dict(agent_member_id=uuid.uuid4(), runtime="claude", state="working", at=NOW)
    base.update(kw)
    return SessionReport(**base)


def _row(**kw) -> SimpleNamespace:
    base = dict(session_key="s-1", permission_widened_at=None, permission_widened_from=None, permission_widened_to=None)
    base.update(kw)
    return SimpleNamespace(**base)


def test_the_closed_list_is_the_model_list_and_the_report_literal():
    assert tuple(get_args(WidenedMode)) == SESSION_WIDENED_MODES
    assert SESSION_WIDENED_MODES == ("plan", "default", "acceptEdits", "auto", "dontAsk", "bypassPermissions")


def test_a_widening_is_carried_whole_or_not_at_all():
    _report(permission_widened_at=NOW, permission_widened_from="plan", permission_widened_to="auto")
    _report()
    with pytest.raises(ValidationError):
        _report(permission_widened_at=NOW)
    with pytest.raises(ValidationError):
        _report(permission_widened_at=NOW, permission_widened_from="plan")


def test_from_equal_to_is_refused_and_an_unknown_mode_too():
    with pytest.raises(ValidationError):
        _report(permission_widened_at=NOW, permission_widened_from="auto", permission_widened_to="auto")
    with pytest.raises(ValidationError):
        _report(permission_widened_at=NOW, permission_widened_from="plan", permission_widened_to="yolo")


def test_the_server_does_not_judge_the_order_only_from_not_equal_to():
    # the daemon's table decides which way is wider; a narrowing pair the daemon sent is not refused here
    _report(permission_widened_at=NOW, permission_widened_from="auto", permission_widened_to="plan")


def test_a_fresh_start_holds_no_widening_and_a_report_without_one_keeps_the_stored():
    row = _row(permission_widened_at=NOW, permission_widened_from="plan", permission_widened_to="auto")
    _set_widened(row, _report(), NOW)  # a report without one: kept
    assert row.permission_widened_to == "auto"
    _set_widened(row, _report(state="starting"), NOW)  # a fresh start: cleared
    assert row.permission_widened_at is None and row.permission_widened_from is None and row.permission_widened_to is None


def test_the_newer_at_replaces_and_an_older_or_equal_one_does_not():
    row = _row(permission_widened_at=NOW, permission_widened_from="plan", permission_widened_to="auto")
    later = NOW + timedelta(minutes=1)
    _set_widened(row, _report(permission_widened_at=later, permission_widened_from="auto", permission_widened_to="bypassPermissions"), NOW)
    assert (row.permission_widened_from, row.permission_widened_to) == ("auto", "bypassPermissions")
    _set_widened(row, _report(permission_widened_at=NOW, permission_widened_from="plan", permission_widened_to="auto"), NOW)
    assert row.permission_widened_to == "bypassPermissions"  # the older one is not stored over the newer


def test_an_at_past_the_server_bound_is_dropped_not_kept():
    row = _row()
    far = NOW + WIDENED_MAX_AHEAD + timedelta(seconds=1)
    _set_widened(row, _report(permission_widened_at=far, permission_widened_from="plan", permission_widened_to="auto"), NOW)
    assert row.permission_widened_at is None


def test_the_reader_sees_the_three_keys_only_while_one_is_stored():
    assert widened_view(_row()) == {}
    row = _row(permission_widened_at=NOW, permission_widened_from="plan", permission_widened_to="auto")
    assert widened_view(row) == {
        "permission_widened_at": NOW.isoformat(), "permission_widened_from": "plan", "permission_widened_to": "auto",
    }
