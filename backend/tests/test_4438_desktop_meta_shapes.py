"""story #4438 — the desktop app's step events carry one closed meta shape per name, checked at the entrance.

Twice on 2026-09-30 a non-string field in an app event became a 500 on the read side (4828 `reason` · 4846 `runtime`: a
list in `in BLOCKED_RUNTIMES`). The entrance (`POST /onboarding/events`) now refuses a meta that breaks its name's shape —
422 `invalid_meta`, nothing stored — so the class is closed in one place. `tests/fixtures/desktop_shell_meta_shapes.json` is
the contract with the app (sprintable-mobile keeps the same file next to its copy of the names): a field added, dropped,
made optional or given other values on one side only turns this red, and the file's sha256 is pinned in both repos.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.routers.onboarding import OnboardingEventBody, post_onboarding_event
from app.services import onboarding_funnel as f

_SNAPSHOT = Path(__file__).resolve().parent / "fixtures/desktop_shell_meta_shapes.json"
M = str(uuid.uuid4())


# The contract file is byte-for-byte the same in sprintable-mobile (desktop-electron/src/shell-meta-shapes.json), and both
# repos pin this sha256 in the same letters (Kadir 228 · PO 19:45Z): changing the file on one side turns that side red, and
# the fix — a new pin — says in its PR that the other repo's copy goes with it.
CONTRACT_SHA256 = "aeff8daabde5ce661e889c834dcaf20c999c1059dbfe668d1279b94c4147f369"  # story #4452: + desktop_agent_start_failed


def test_every_name_the_app_sends_has_one_shape_and_the_contract_file_matches_values_included():
    assert set(f.DESKTOP_SHELL_META_SHAPES) == f.DESKTOP_SHELL_EMIT_EVENTS
    # the server's own table, required flags AND value specs (enum values · const · type), equals the contract file
    assert f.DESKTOP_SHELL_META_SHAPES == json.loads(_SNAPSHOT.read_text(encoding="utf-8"))


def test_the_contract_file_is_the_pinned_one():
    assert hashlib.sha256(_SNAPSHOT.read_bytes()).hexdigest() == CONTRACT_SHA256


def test_every_value_spec_is_one_the_check_knows_and_an_unknown_one_never_fits():
    known = ({"required", "type"}, {"required", "enum"}, {"required", "const"})
    for name, shape in f.DESKTOP_SHELL_META_SHAPES.items():
        for field, spec in shape.items():
            assert set(spec) in known, (name, field)
            assert spec.get("type", "bool") in {"bool", "uuid", "int32"}, (name, field)
    for v in (True, "x", 1, None, [], {}):
        assert f._fits({"required": True, "type": "text"}, v) is False
        assert f._fits({"required": True}, v) is False


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _db():
    db = MagicMock()
    none = MagicMock(); none.first.return_value = None
    db.execute = AsyncMock(return_value=none)
    db.add = MagicMock()
    db.commit = AsyncMock()
    db.flush = AsyncMock()
    return db


# what the app sends today (desktop-electron setup-flow.ts), and the optional fields left out
GOOD = [
    ("desktop_workdir_fallback", {"hinted": True}),
    ("desktop_workdir_fallback", {"hinted": False}),
    ("desktop_setup_blocked", {"reason": "managed_mcp", "runtime": "claude", "when": "found"}),
    ("desktop_setup_blocked", {"reason": "managed_mcp", "runtime": "codex", "when": "after_start"}),
    ("desktop_setup_blocked", {"reason": "managed_mcp"}),
    ("desktop_first_screen_human_input", {"human_hand": True}),
    ("desktop_first_task_handed", {"via": "start"}),
    ("desktop_first_task_handed", {"via": "turn"}),
    ("desktop_setup_signed_in", {}),
    ("desktop_agent_ended_early", {"member_id": M, "runtime": "claude", "exit_code": 1}),
    ("desktop_agent_ended_early", {"member_id": M, "runtime": "codex", "exit_code": -2147483648}),
    ("desktop_agent_ended_early", {"member_id": M}),
    ("desktop_agent_restarted", {"member_id": M}),
    # story #4452
    ("desktop_agent_start_failed", {"member_id": M, "reason": "start_refused", "code": "adapter_prepare_failed", "runtime": "codex"}),
    ("desktop_agent_start_failed", {"member_id": M, "reason": "start_refused", "code": "session_limit", "limit": 3}),
    ("desktop_agent_start_failed", {"member_id": M, "reason": "first_not_ready", "code": "timeout", "first_member_id": M}),
    ("desktop_agent_start_failed", {"member_id": M, "reason": "runtime_missing", "runtime": "claude"}),
]


@pytest.mark.anyio
@pytest.mark.parametrize("event,meta", GOOD)
async def test_the_shapes_the_app_sends_are_stored(event, meta):
    db = _db()
    await post_onboarding_event(OnboardingEventBody(event=event, session_id=uuid.uuid4(), meta=meta), db=db, credentials=None, x_agent_api_key=None)
    assert db.add.called


BAD = [
    ("desktop_setup_blocked", {"reason": ["managed_mcp"]}, "reason"),  # 4828's class
    ("desktop_setup_blocked", {"reason": 1}, "reason"),
    ("desktop_setup_blocked", {"reason": "other"}, "reason"),
    ("desktop_setup_blocked", {"reason": "managed_mcp", "runtime": ["claude"]}, "runtime"),
    ("desktop_setup_blocked", {"reason": "managed_mcp", "when": {"a": 1}}, "when"),
    ("desktop_setup_blocked", {}, "reason"),
    ("desktop_agent_ended_early", {"member_id": M, "runtime": ["claude"]}, "runtime"),  # 4846's class
    ("desktop_agent_ended_early", {"member_id": M, "runtime": "vim"}, "runtime"),
    ("desktop_agent_ended_early", {"member_id": M, "exit_code": "1"}, "exit_code"),
    ("desktop_agent_ended_early", {"member_id": M, "exit_code": True}, "exit_code"),
    ("desktop_agent_ended_early", {"member_id": M, "exit_code": 2**40}, "exit_code"),
    ("desktop_agent_ended_early", {"member_id": 5}, "member_id"),
    ("desktop_agent_ended_early", {"member_id": "not-a-uuid"}, "member_id"),
    ("desktop_agent_ended_early", {"runtime": "claude"}, "member_id"),
    ("desktop_agent_restarted", {}, "member_id"),
    ("desktop_first_screen_human_input", {"human_hand": "true"}, "human_hand"),
    ("desktop_first_screen_human_input", {"human_hand": False}, "human_hand"),
    ("desktop_first_task_handed", {"via": "mail"}, "via"),
    ("desktop_workdir_fallback", {"hinted": "yes"}, "hinted"),
    # story #4452
    ("desktop_agent_start_failed", {"reason": "start_refused"}, "member_id"),
    ("desktop_agent_start_failed", {"member_id": M}, "reason"),
    ("desktop_agent_start_failed", {"member_id": M, "reason": "crashed"}, "reason"),
    ("desktop_agent_start_failed", {"member_id": M, "reason": "start_refused", "code": "could not start /usr/local/bin/codex"}, "code"),
    ("desktop_agent_start_failed", {"member_id": M, "reason": "start_refused", "limit": "3"}, "limit"),
    ("desktop_agent_start_failed", {"member_id": M, "reason": "first_not_ready", "first_member_id": "Any"}, "first_member_id"),
]


@pytest.mark.anyio
@pytest.mark.parametrize("event,meta,field", BAD)
async def test_a_meta_off_its_shape_is_a_closed_422_and_nothing_is_stored(event, meta, field):
    db = _db()
    with pytest.raises(HTTPException) as e:
        await post_onboarding_event(OnboardingEventBody(event=event, session_id=uuid.uuid4(), meta=meta), db=db, credentials=None, x_agent_api_key=None)
    assert e.value.status_code == 422
    assert e.value.detail == {"code": "invalid_meta", "message": "meta does not fit this event's shape", "event": event, "field": field}
    assert not db.add.called and not db.commit.called


# PO 19:07Z: a field outside the shape is dropped, not refused — refusing the whole event would lose it (a hand not counted,
# a lie in the numbers), and an app build that adds a field before the server knows it would lose every such event
EXTRA = [
    ("desktop_agent_restarted", {"member_id": M, "path": "/Users/x"}, {"member_id": M}),
    ("desktop_setup_signed_in", {"human_hand": True}, {}),
    ("desktop_first_screen_human_input", {"human_hand": True, "new_field": [1, 2]}, {"human_hand": True}),
]


@pytest.mark.anyio
@pytest.mark.parametrize("event,meta,stored", EXTRA)
async def test_a_field_outside_the_shape_is_dropped_and_the_rest_stored(event, meta, stored):
    db = _db()
    await post_onboarding_event(OnboardingEventBody(event=event, session_id=uuid.uuid4(), meta=meta), db=db, credentials=None, x_agent_api_key=None)
    assert db.add.called
    row = db.add.call_args[0][0]
    assert row.meta == stored


@pytest.mark.anyio
async def test_the_webs_names_are_not_shape_checked_here():
    """The check is the desktop app's names only (the web's and the server's are out of this story)."""
    db = _db()
    await post_onboarding_event(OnboardingEventBody(event=sorted(f.FE_EMIT_EVENTS)[0], session_id=uuid.uuid4(), meta={"anything": [1, 2]}), db=db, credentials=None, x_agent_api_key=None)
    assert db.add.called
