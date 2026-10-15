"""story #4445 — the web response-shape guard reads the backend's answer shapes from a committed snapshot
(scripts/web_api_route_shapes.json). This keeps it fresh: change a route's response model (or add a route) and this test
is red until the snapshot is regenerated — which in turn re-runs the web guard against the new shape."""
from __future__ import annotations

import json


def test_the_web_route_shape_snapshot_matches_the_app():
    from app.main import app
    from scripts.dump_web_route_shapes import SNAPSHOT, route_shapes

    committed = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    current = route_shapes(app)
    assert committed == current, (
        "scripts/web_api_route_shapes.json is stale — regenerate it: "
        "(cd backend && PYTHONPATH=. uv run python scripts/dump_web_route_shapes.py)"
    )
