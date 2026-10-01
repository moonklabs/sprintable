"""story #4445 — the backend's answer shapes, for the web response-shape guard (scripts/verify_web_api_response_shapes.py).

Every APIRoute of the running app: method · path · the shape of a success body —
  array        `response_model=list[...]` (a bare JSON array)
  object       a response model without a `data` field (a bare JSON object)
  envelope     a response model with a `data` field, or a handler that returns a `{"data": ...}` literal
  unknown      `dict` / no model and no `{"data"` literal (the guard does not judge these)
The backend adds no success envelope of its own; `{ data }` around a body comes from the web's BFF (`apiSuccess`).

Usage: (cd backend && PYTHONPATH=. uv run python scripts/dump_web_route_shapes.py)  → writes ../scripts/web_api_route_shapes.json
The snapshot is checked fresh by tests/test_4445_web_route_shapes_snapshot.py.
"""
from __future__ import annotations

import inspect
import json
import re
import sys
import typing
from pathlib import Path

SNAPSHOT = Path(__file__).resolve().parents[2] / "scripts" / "web_api_route_shapes.json"
_DATA_LITERAL = re.compile(r"""\{\s*["']data["']\s*:""")


def _kind(rm) -> str:
    if rm is None:
        return "unknown"
    origin = typing.get_origin(rm)
    if origin is list:
        return "array"
    if origin in (typing.Union, getattr(__import__("types"), "UnionType", None)):
        kinds = {_kind(a) for a in typing.get_args(rm) if a is not type(None)}
        return kinds.pop() if len(kinds) == 1 else "unknown"
    if rm is dict or origin is dict:
        return "unknown"
    fields = getattr(rm, "model_fields", None)
    if fields is not None:
        return "envelope" if "data" in fields else "object"
    return "unknown"


def route_shapes(app) -> list[dict]:
    from fastapi.routing import APIRoute

    rows = []
    for r in app.routes:
        if not isinstance(r, APIRoute):
            continue
        kind = _kind(r.response_model)
        if kind == "unknown":
            try:
                src = inspect.getsource(r.endpoint)
            except (OSError, TypeError):
                src = ""
            if _DATA_LITERAL.search(src):
                kind = "envelope"
        path = re.sub(r"\{[^}]*\}", "{}", r.path)
        for m in sorted(r.methods - {"HEAD"}):
            rows.append({"method": m, "path": path, "kind": kind})
    rows.sort(key=lambda x: (x["path"], x["method"]))
    # one shape per (method, path): a path declared twice keeps «unknown» unless both agree
    out: dict[tuple[str, str], dict] = {}
    for row in rows:
        key = (row["method"], row["path"])
        if key in out and out[key]["kind"] != row["kind"]:
            out[key]["kind"] = "unknown"
        else:
            out.setdefault(key, row)
    return list(out.values())


def render(app) -> str:
    return json.dumps(route_shapes(app), ensure_ascii=False, indent=0) + "\n"


if __name__ == "__main__":
    from app.main import app

    SNAPSHOT.write_text(render(app), encoding="utf-8")
    print(f"wrote {SNAPSHOT} ({len(route_shapes(app))} routes)", file=sys.stderr)
