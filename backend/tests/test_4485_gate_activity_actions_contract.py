"""story #4485 — the gate's approval history shows every `ActivityLog` row with `entity_type="gate"` (routers/gates.py
`list_gate_activity_endpoint`), and the web names each `action` through `GATE_ACTIVITY_LABEL_KEY` — a key it does not know
showed as the raw string (3806 · 4898's `ads_boost_cancelled` · the delegate/toss/discussion/delivery-failure keys found in AC0).

One closed list joins the two sides: `contracts/gate-activity-actions.json`. This test keeps it **equal** to what the backend
writes — every `action=` of a call that also says `entity_type="gate"`, read from the source (no DB). A new action must be
added to the list, and the web test (gate-evidence.4485.test.ts) then demands its ko/en label.

What an `action=` may be, so it can be read here: a string · a module constant · a module dict of strings indexed by
something (all its values count) · `f"gate_{status}"` (every destination status of `models/gate.py` `_VALID_TRANSITIONS`).
Anything else fails with its file:line — write it as one of those.
"""
from __future__ import annotations

import ast
import json
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
_APP = _BACKEND / "app"
_LIST = _BACKEND.parent / "contracts" / "gate-activity-actions.json"


def _module_constants(tree: ast.Module) -> dict[str, ast.expr]:
    out: dict[str, ast.expr] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            out[node.targets[0].id] = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value is not None:
            out[node.target.id] = node.value
    return out


def _gate_destinations() -> list[str]:
    from app.models.gate import _VALID_TRANSITIONS

    return sorted({to for _from, to in _VALID_TRANSITIONS})


def resolve_action(expr: ast.expr, constants: dict[str, ast.expr]) -> list[str] | None:
    """The action names an `action=` expression can be, or None when it cannot be read from the source."""
    if isinstance(expr, ast.Constant) and isinstance(expr.value, str):
        return [expr.value]
    if isinstance(expr, ast.Name) and expr.id in constants:
        return resolve_action(constants[expr.id], constants)
    if isinstance(expr, ast.Subscript) and isinstance(expr.value, ast.Name) and isinstance(constants.get(expr.value.id), ast.Dict):
        values: list[str] = []
        for v in constants[expr.value.id].values:  # type: ignore[union-attr]
            got = resolve_action(v, constants)
            if got is None:
                return None
            values += got
        return values
    if (isinstance(expr, ast.JoinedStr) and len(expr.values) == 2 and isinstance(expr.values[0], ast.Constant)
            and expr.values[0].value == "gate_" and isinstance(expr.values[1], ast.FormattedValue)):
        return [f"gate_{to}" for to in _gate_destinations()]
    return None


def gate_actions_in(source: str, where: str) -> tuple[set[str], list[str]]:
    """(actions written on gates, places that could not be read)."""
    tree = ast.parse(source)
    constants = _module_constants(tree)
    found: set[str] = set()
    unread: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        kw = {k.arg: k.value for k in node.keywords if k.arg}
        et = kw.get("entity_type")
        if not (isinstance(et, ast.Constant) and et.value == "gate") or "action" not in kw:
            continue
        got = resolve_action(kw["action"], constants)
        if got is None:
            unread.append(f"{where}:{node.lineno}")
        else:
            found.update(got)
    return found, unread


def _written_by_the_backend() -> tuple[set[str], list[str]]:
    found: set[str] = set()
    unread: list[str] = []
    for path in sorted(_APP.rglob("*.py")):
        got, bad = gate_actions_in(path.read_text(encoding="utf-8"), str(path.relative_to(_BACKEND)))
        found |= got
        unread += bad
    return found, unread


def test_the_closed_list_is_exactly_what_the_backend_writes_on_gates():
    listed = set(json.loads(_LIST.read_text(encoding="utf-8"))["actions"])
    written, unread = _written_by_the_backend()
    assert not unread, f"action= that cannot be read from the source (write a string · a module constant · a dict of them): {unread}"
    missing = sorted(written - listed)
    stale = sorted(listed - written)
    assert not missing, (
        f"the backend writes gate actions not in contracts/gate-activity-actions.json: {missing} — add them there "
        "(the web test then asks for their ko/en labels in GATE_ACTIVITY_LABEL_KEY)"
    )
    assert not stale, f"contracts/gate-activity-actions.json lists actions nothing writes any more: {stale} — remove them"


def test_the_list_is_sorted_and_without_repeats():
    actions = json.loads(_LIST.read_text(encoding="utf-8"))["actions"]
    assert actions == sorted(set(actions))


def test_the_reader_resolves_each_shape_and_names_what_it_cannot():
    """The reader itself: each allowed shape is read; anything else is reported by line (never skipped in silence)."""
    src = '''
_SENT = "thing_sent"
_BY_OP = {"a": "thing_started", "b": _SENT}

def f(op, status, other, db):
    record(entity_type="gate", action="thing_done")
    record(entity_type="gate", action=_SENT)
    record(entity_type="gate", action=_BY_OP[op])
    record(entity_type="gate", action=f"gate_{status}")
    record(entity_type="story", action="not_a_gate_one")
    record(entity_type="gate", action=other)
    record(entity_type="gate", action="x" + other)
'''
    found, unread = gate_actions_in(src, "m.py")
    assert {"thing_done", "thing_sent", "thing_started", "gate_approved", "gate_held"} <= found
    assert "not_a_gate_one" not in found
    assert unread == ["m.py:11", "m.py:12"]
