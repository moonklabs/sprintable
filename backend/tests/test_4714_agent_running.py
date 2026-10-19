"""story 4714 (AC3 · AC4) — `_agent_running`: the one word the phone's whole-screen read says about each agent, which decides whether the phone opens the
chat list or the start screen. Pure function; the realdb test (`test_4714_start_realdb.py::test_09b…`) holds it through the real read.
Each case goes red without the line it names (mutants in the PR body)."""
from __future__ import annotations

import uuid

from app.services.desktop_commands import _agent_running

A = uuid.UUID("22222222-3333-4444-8555-666666666666")
B = uuid.UUID("22222222-3333-4444-8555-777777777777")


def _row(agent: uuid.UUID, state: str) -> dict:
    return {"agent_member_id": str(agent), "session_key": f"k-{state}", "state": state}


def test_a_session_that_lives_is_running_whatever_else_there_is():
    for live in ("running", "idle", "waiting_input"):
        assert _agent_running([_row(A, "stopped"), _row(A, live)], A, True) is True
    assert _agent_running([_row(A, "running")], A, False) is True  # a live row is known even when the computer is quiet now


def test_every_session_over_or_none_at_all_on_a_computer_that_is_heard_is_not_running():
    assert _agent_running([], A, True) is False
    assert _agent_running([_row(A, "stopped"), _row(A, "stopped")], A, True) is False


def test_what_cannot_be_known_is_none_never_a_no():
    # a session of a computer that was not heard from reads `unknown` — it may still live; and a quiet computer with nothing on record says nothing either
    assert _agent_running([_row(A, "unknown")], A, True) is None  # the rows alone say it, even when the caller believes the computer is heard
    assert _agent_running([_row(A, "stopped"), _row(A, "unknown")], A, True) is None
    assert _agent_running([], A, False) is None
    assert _agent_running([_row(A, "stopped")], A, False) is None


def test_only_this_agents_own_sessions_count():
    assert _agent_running([_row(B, "running")], A, True) is False
    assert _agent_running([_row(B, "running"), _row(A, "stopped")], A, True) is False
    assert _agent_running([_row(B, "unknown")], A, True) is False
