"""story #4438 — the desktop app's step events carry one closed meta shape per name, checked at the entrance.

Twice on 2026-09-30 a non-string field in an app event became a 500 on the read side (4828 `reason` · 4846 `runtime`: a
list in `in BLOCKED_RUNTIMES`). The entrance (`POST /onboarding/events`) now refuses a meta that breaks its name's shape —
422 `invalid_meta`, nothing stored — so the class is closed in one place. `tests/fixtures/desktop_shell_meta_shapes.json` is
the contract with the app (sprintable-mobile keeps the same file next to its copy of the names): a field added, dropped or
made optional on one side only turns this red.
"""
from __future__ import annotations

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


def test_every_name_the_app_sends_has_one_shape_and_the_contract_file_matches():
    assert set(f.DESKTOP_SHELL_META_SHAPES) == f.DESKTOP_SHELL_EMIT_EVENTS
    table = {name: {field: ("required" if req else "optional") for field, (req, _c) in shape.items()} for name, shape in f.DESKTOP_SHELL_META_SHAPES.items()}
    assert table == json.loads(_SNAPSHOT.read_text(encoding="utf-8"))


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
    ("desktop_agent_restarted", {"member_id": M, "path": "/Users/x"}, "path"),  # no field outside the shape
    ("desktop_first_screen_human_input", {"human_hand": "true"}, "human_hand"),
    ("desktop_first_screen_human_input", {"human_hand": False}, "human_hand"),
    ("desktop_first_task_handed", {"via": "mail"}, "via"),
    ("desktop_workdir_fallback", {"hinted": "yes"}, "hinted"),
    ("desktop_setup_signed_in", {"human_hand": True}, "human_hand"),
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


@pytest.mark.anyio
async def test_the_webs_names_are_not_shape_checked_here():
    """The check is the desktop app's names only (the web's and the server's are out of this story)."""
    db = _db()
    await post_onboarding_event(OnboardingEventBody(event=sorted(f.FE_EMIT_EVENTS)[0], session_id=uuid.uuid4(), meta={"anything": [1, 2]}), db=db, credentials=None, x_agent_api_key=None)
    assert db.add.called
