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
