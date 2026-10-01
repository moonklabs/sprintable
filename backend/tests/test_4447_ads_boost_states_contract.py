"""story #4447 — the boost card's value sets are the server's contract: one backend module, published as openapi enums on /spend,
and a TypeScript file generated from it for the web (apps/web/src/lib/ads-boost-states.generated.ts). Change a set and this is red
until the TypeScript file is regenerated: (cd backend && PYTHONPATH=. uv run python scripts/gen_ads_boost_states_ts.py)."""
from __future__ import annotations


# the web file this contract reaches (a plain path string, so check_backend_relevant_diff runs this test when that file changes)
_WEB_FILE = "apps/web/src/lib/ads-boost-states.generated.ts"


def test_the_web_file_is_generated_from_the_backend_sets():
    from scripts.gen_ads_boost_states_ts import TS_FILE, render

    assert str(TS_FILE).endswith(_WEB_FILE)
    assert TS_FILE.read_text(encoding="utf-8") == render(), (
        f"{_WEB_FILE} is stale — (cd backend && PYTHONPATH=. uv run python scripts/gen_ads_boost_states_ts.py)"
    )


def test_spend_publishes_the_sets_as_openapi_enums():
    from app.main import app
    from app.services.ads_boost_states import BOOST_RUN_STATUSES, COMMAND_FAILURE_KINDS, COMMAND_STATUSES

    schemas = app.openapi()["components"]["schemas"]
    run_status = schemas["SpendSummaryResponse"]["properties"]["run_status"]
    command = schemas["StartCommandView"]["properties"]
    enums = lambda prop: next(o["enum"] for o in [prop, *prop.get("anyOf", [])] if "enum" in o)  # noqa: E731
    assert enums(run_status) == list(BOOST_RUN_STATUSES)
    assert enums(command["status"]) == list(COMMAND_STATUSES)
    assert enums(command["failure_kind"]) == list(COMMAND_FAILURE_KINDS)


def test_the_run_sets_are_the_values_the_server_writes():
    """`failed` was in the web type but no code writes it; `pause_pending` is written by a delayed pause."""
    import re
    from pathlib import Path

    from app.services.ads_boost_states import BOOST_RUN_STATUSES

    src = (Path(__file__).resolve().parents[1] / "app" / "services" / "ads_boost_execution.py").read_text(encoding="utf-8")
    written = set(re.findall(r'run\.status = "([a-z_]+)"', src)) | {"pending"}  # «pending» is the column default
    assert set(BOOST_RUN_STATUSES) == written


def _command_status_writes() -> dict[str, set[str]]:
    """Every value the server writes to a publication command's status: `command.status = <str>` and `command.status = STATUS_X`
    anywhere under app/ (STATUS_X resolved through the module that defines it), plus the column default. Value → files."""
    import ast
    from pathlib import Path

    import app.models.publication_command as model
    import app.services.publication_command as service

    root = Path(__file__).resolve().parents[1] / "app"
    found: dict[str, set[str]] = {"pending": {"models/publication_command.py (column default)"}}
    for f in root.rglob("*.py"):
        for node in ast.walk(ast.parse(f.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Assign):
                continue
            for target in node.targets:
                if not (isinstance(target, ast.Attribute) and target.attr == "status" and isinstance(target.value, ast.Name)
                        and target.value.id == "command"):
                    continue
                v = node.value
                if isinstance(v, ast.Constant) and isinstance(v.value, str):
                    value = v.value
                elif isinstance(v, ast.Name) and v.id.startswith("STATUS_"):
                    value = getattr(model, v.id, None) or getattr(service, v.id)
                else:
                    raise AssertionError(f"{f}:{node.lineno} writes command.status from an expression the guard cannot read")
                found.setdefault(value, set()).add(str(f.relative_to(root)))
    return found


def test_every_status_the_server_writes_to_a_command_is_in_the_contract():
    """Qadir 4870 ①: the ads start path writes `blocked_unapproved` (the old note said newsletter-only) and the card drew «unknown»,
    losing the reason and the way on; `cancelled` (channel posts) was missing the same way. The set the card branches on is the
    model's own list, and every value written to `command.status` must be in it — a new status without a contract entry is red here.

    What this misses (declared): writes through another variable name than `command` (none for publication commands today — the
    other `.status` writers under app/ are other models) and raw SQL status updates (none today)."""
    from app.models.publication_command import PUBLICATION_COMMAND_STATUSES
    from app.services.ads_boost_states import COMMAND_STATUSES

    written = _command_status_writes()
    # the floor: the scan really sees the known writers (an empty or blind scan would pass the subset check on nothing)
    assert {"blocked", "blocked_unapproved", "cancelled", "completed", "dead_letter", "in_progress", "pending", "voided"} <= set(written)
    missing = {v: sorted(files) for v, files in written.items() if v not in COMMAND_STATUSES}
    assert not missing, f"written to command.status but not in the contract: {missing}"
    assert tuple(COMMAND_STATUSES) == tuple(PUBLICATION_COMMAND_STATUSES)
