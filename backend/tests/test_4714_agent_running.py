"""story 4714 (AC3 · AC4) — `_agent_running`: the one word the phone's whole-screen read says about each agent, which decides whether the phone opens the
chat list or the start screen. Pure function; the realdb test (`test_4714_start_realdb.py::test_09b…`) holds it through the real read.
Each case goes red without the line it names (mutants in the PR body)."""
from __future__ import annotations

from app.services.desktop_commands import _agent_running


def test_a_session_that_is_not_over_is_running_on_a_computer_that_is_heard():
    for live in ("running", "idle", "waiting_input", "error", "paused_limit"):
        assert _agent_running(["stopped", live], True) is True
    assert _agent_running(["running", "running"], True) is True


def test_none_at_all_or_every_one_over_on_a_computer_that_is_heard_is_not_running():
    assert _agent_running([], True) is False
    assert _agent_running(["stopped"], True) is False
    assert _agent_running(["stopped", "stopped"], True) is False


def test_a_computer_that_was_not_heard_from_says_nothing_never_a_no():
    # a session it had may still live, and an empty list is no «no» from a silent computer either
    assert _agent_running(["running"], False) is None
    assert _agent_running(["stopped"], False) is None
    assert _agent_running([], False) is None
