"""story #4447 — writes the boost card's value sets (app/services/ads_boost_states.py) as a TypeScript file for the web.

Usage: (cd backend && PYTHONPATH=. uv run python scripts/gen_ads_boost_states_ts.py)
Kept fresh by tests/test_4447_ads_boost_states_contract.py. Local/test only — no database."""
from __future__ import annotations

from pathlib import Path

TS_FILE = Path(__file__).resolve().parents[2] / "apps" / "web" / "src" / "lib" / "ads-boost-states.generated.ts"


def _tuple(name: str, values: tuple[str, ...]) -> str:
    return f"export const {name} = [{', '.join(repr(v).replace(chr(39), chr(39)) for v in values)}] as const;\n"


def render() -> str:
    from app.services.ads_boost_states import BOOST_RUN_STATUSES, COMMAND_FAILURE_KINDS, COMMAND_STATUSES

    return (
        "// GENERATED — do not edit. Source: backend/app/services/ads_boost_states.py (story #4447).\n"
        "// Regenerate: (cd backend && PYTHONPATH=. uv run python scripts/gen_ads_boost_states_ts.py)\n"
        + _tuple("BOOST_RUN_STATUSES", BOOST_RUN_STATUSES)
        + _tuple("COMMAND_STATUSES", COMMAND_STATUSES)
        + _tuple("COMMAND_FAILURE_KINDS", COMMAND_FAILURE_KINDS)
        + "export type BoostRunStatus = (typeof BOOST_RUN_STATUSES)[number];\n"
        + "export type CommandStatus = (typeof COMMAND_STATUSES)[number];\n"
        + "export type CommandFailureKind = (typeof COMMAND_FAILURE_KINDS)[number];\n"
    )


if __name__ == "__main__":
    TS_FILE.write_text(render(), encoding="utf-8")
    print(f"wrote {TS_FILE}")
