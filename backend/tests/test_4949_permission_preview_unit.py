"""story 4949 — the preview a file tool's permission request carries: the report's own limits (422, never trimmed), the shapes that cannot exist
(a withdrawn preview with lines · a write that removes · a terminal-only one), and nothing a field name can smuggle (extra → 422)."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.services.agent_permissions import (
    PREVIEW_ADDED_MAX, PREVIEW_BLOCKS_MAX, PREVIEW_CHARS_MAX, PREVIEW_LINE_MAX, PREVIEW_REMOVED_MAX, PermissionRequestReport,
)


def _report(**extra):
    return {"request_id": str(uuid.uuid4()), "session_key": "s-1", "agent_member_id": str(uuid.uuid4()), "runtime": "claude", "tool": "Write",
            "summary": "note.txt", "input_hash": "sha256:" + "a" * 64, "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(), **extra}


def _tool_of(preview):
    return "Write" if isinstance(preview, dict) and preview.get("op") == "write" else "Edit"


def _ok(preview, **extra):
    return PermissionRequestReport.model_validate(_report(preview=preview, **{"tool": _tool_of(preview), **extra}))


def _bad(preview, **extra):
    with pytest.raises(ValidationError):
        PermissionRequestReport.model_validate(_report(preview=preview, **{"tool": _tool_of(preview), **extra}))


def test_a_write_and_an_edit_preview_pass_and_none_is_none():
    assert PermissionRequestReport.model_validate(_report()).preview is None
    w = _ok({"op": "write", "blocks": [{"added": ["a", "b"], "added_more": 3}]})
    assert w.preview.blocks[0].added == ["a", "b"] and w.preview.blocks[0].removed == []
    e = _ok({"op": "edit", "blocks": [{"removed": ["old"], "added": ["new"]}], "replace_all": True})
    assert e.preview.replace_all is True
    assert _ok({"op": "edit", "blocks": [{"removed": ["x"], "added": ["y"]}] * PREVIEW_BLOCKS_MAX, "blocks_more": 4}, tool="MultiEdit").preview.blocks_more == 4


def test_the_limits_are_the_servers_own_and_a_body_over_them_is_refused_not_trimmed():
    _bad({"op": "edit", "blocks": [{"removed": ["x"] * (PREVIEW_REMOVED_MAX + 1)}]})
    _bad({"op": "edit", "blocks": [{"added": ["x"] * (PREVIEW_ADDED_MAX + 1)}]})
    _bad({"op": "edit", "blocks": [{"added": ["x" * (PREVIEW_LINE_MAX + 1)]}]})
    _bad({"op": "edit", "blocks": [{"added": ["x"]}] * (PREVIEW_BLOCKS_MAX + 1)})
    # the total: 3 blocks of 10 + 12 lines at 120 characters is over 2,400
    full = {"removed": ["y" * PREVIEW_LINE_MAX] * PREVIEW_REMOVED_MAX, "added": ["z" * PREVIEW_LINE_MAX] * PREVIEW_ADDED_MAX}
    assert (PREVIEW_REMOVED_MAX + PREVIEW_ADDED_MAX) * PREVIEW_LINE_MAX > PREVIEW_CHARS_MAX
    _bad({"op": "edit", "blocks": [full]})
    _bad({"op": "edit", "blocks": [{"added": ["x"], "added_more": -1}]})


def test_a_shape_that_cannot_be_is_refused():
    _bad({"op": "write", "blocks": [{"removed": ["old"], "added": ["new"]}]})  # a write removes nothing
    _bad({"op": "write", "blocks": [{"added": ["a"]}, {"added": ["b"]}]})  # a write is one block
    _bad({"op": "write", "blocks": [{"added": ["a"]}], "replace_all": True})
    _bad({"op": "edit", "blocks": [{"added": ["a"]}], "withheld": "sensitive_path"})  # a withheld preview carries no lines
    assert _ok({"op": "write", "blocks": [], "withheld": "sensitive_path"}).preview.withheld == "sensitive_path"
    _bad({"op": "write", "blocks": [], "withheld": "anything-else"})
    _bad({"op": "move", "blocks": []})


def test_a_preview_belongs_to_a_claude_file_tool_and_the_right_kind_of_it(  # codex 4949 · security
):
    ok = {"op": "write", "blocks": [{"added": ["a"]}]}
    edit = {"op": "edit", "blocks": [{"removed": ["a"], "added": ["b"]}]}
    for tool in ("Bash", "Read", "SandboxNetwork", "mcp__x__Write"):
        with pytest.raises(ValidationError):
            PermissionRequestReport.model_validate(_report(tool=tool, preview=ok))  # free text has its own masking path — no preview of it
    with pytest.raises(ValidationError):
        PermissionRequestReport.model_validate(_report(tool="Edit", preview=ok))  # a write's preview on an Edit
    with pytest.raises(ValidationError):
        PermissionRequestReport.model_validate(_report(tool="Write", preview=edit))  # an edit's preview on a Write
    with pytest.raises(ValidationError):
        PermissionRequestReport.model_validate(_report(tool="Write", runtime="codex", preview=ok))  # only Claude's inputs are read
    assert PermissionRequestReport.model_validate(_report(tool="MultiEdit", preview=edit)).preview.op == "edit"
    assert PermissionRequestReport.model_validate(_report(tool="Write", preview=ok)).preview.op == "write"


def test_an_empty_preview_and_a_loose_type_or_a_line_break_are_refused():  # codex 4949
    _bad({"op": "write", "blocks": []})  # a write shows one block
    _bad({"op": "edit", "blocks": []})  # an edit shows at least one
    _bad({"op": "write", "blocks": [{}]})  # a block with no line and no count is not a preview (codex 4949 round 2)
    _bad({"op": "edit", "blocks": [{"removed": [], "added": [], "removed_more": 0, "added_more": 0}]})
    _ok({"op": "edit", "blocks": [{"added_more": 3}]})  # counts alone are something: lines were left out
    _bad({"op": "write", "blocks": [{"added": ["a"]}], "replace_all": "false"})  # strict: a string is not a boolean
    _bad({"op": "edit", "blocks": [{"removed": ["a"], "added_more": True}]})  # nor a boolean a count
    for sep in ("\n", "\r", "\u2028", "\u2029", "\x0b", "\x0c", "\x85"):
        _bad({"op": "write", "blocks": [{"added": [f"one{sep}two"]}]})
        _bad({"op": "edit", "blocks": [{"removed": [f"one{sep}two"], "added": ["x"]}]})


def test_nothing_else_can_ride_in_it_and_a_terminal_only_question_carries_none():
    _bad({"op": "write", "blocks": [{"added": ["a"], "path": "/Users/me/x"}]})
    _bad({"op": "write", "blocks": [], "content": "the whole file"})
    with pytest.raises(ValidationError):
        PermissionRequestReport.model_validate({**_report(preview={"op": "write", "blocks": [{"added": ["a"]}]}), "terminal_only": True, "input_hash": None})
