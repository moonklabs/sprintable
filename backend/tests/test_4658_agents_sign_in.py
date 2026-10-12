# story #4658 (PO 17072 (a)) — the setup status reads who asks for a sign-in now: the last ask of this setup's agents, cleared by their
# «signed in»; a runtime outside claude · codex is None; another setup's member is ignored (pure: no database).
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.services.desktop_setup import _agents_sign_in

M1 = str(uuid.uuid4())
M2 = str(uuid.uuid4())
OTHER = str(uuid.uuid4())
T0 = datetime(2026, 10, 12, tzinfo=timezone.utc)


def _setup():
    return SimpleNamespace(members=[
        {"member_id": M1, "kind": "agent", "runtime": "claude"},
        {"member_id": M2, "kind": "agent", "runtime": "codex"},
        {"member_id": "p", "kind": "person"},
    ])


def _row(event, mid, at, **extra):
    return (event, {"member_id": mid, **extra}, T0 + timedelta(seconds=at))


def test_an_ask_is_listed_with_its_runtime_then_cleared_by_signed_in():
    rows = [_row("desktop_agent_needs_sign_in", M1, 1, runtime="claude")]
    out = _agents_sign_in(_setup(), rows)
    assert [(r["member_id"], r["runtime"], r["at"]) for r in out] == [(M1, "claude", T0 + timedelta(seconds=1))]
    rows.append(_row("desktop_agent_signed_in", M1, 2))
    assert _agents_sign_in(_setup(), rows) == []


def test_a_new_ask_after_a_release_is_listed_again():
    rows = [_row("desktop_agent_needs_sign_in", M1, 1, runtime="claude"), _row("desktop_agent_signed_in", M1, 2),
            _row("desktop_agent_needs_sign_in", M1, 3, runtime="claude")]
    assert [r["member_id"] for r in _agents_sign_in(_setup(), rows)] == [M1]


def test_a_runtime_outside_claude_and_codex_is_none_and_another_setups_member_is_ignored():
    rows = [_row("desktop_agent_needs_sign_in", M2, 1, runtime="vim"), _row("desktop_agent_needs_sign_in", OTHER, 2, runtime="claude")]
    out = _agents_sign_in(_setup(), rows)
    assert [(r["member_id"], r["runtime"]) for r in out] == [(M2, None)]


def test_the_order_is_the_setups_order():
    rows = [_row("desktop_agent_needs_sign_in", M2, 1), _row("desktop_agent_needs_sign_in", M1, 2)]
    assert [r["member_id"] for r in _agents_sign_in(_setup(), rows)] == [M1, M2]
