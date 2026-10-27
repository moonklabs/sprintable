"""story 4796 — the VM backend's database pool fits the VM database's connection budget, and is big enough for what ran on the first day.

Day one of the dev move: one backend process on direct connections with a pool of 5 + 5 was exhausted by the lane streams, 26 relays and the frontend (`QueuePool limit of size 5 overflow 5 reached, timeout 30`,
165 times in 6 minutes, relay POSTs answered 502 by Caddy). The pool is sized from the database's `max_connections` (compose.yml) minus what else connects, for both environments:

  usable = max_connections - 3 (superuser reserved)
  the backend holds  request pool (DB_POOL_SIZE + DB_MAX_OVERFLOW) + worker pool (config default 2 + 1) + the raw LISTEN connection outside the pools (1)
  beside it          migrate at deploy time (2) + the backup's pg_dump (1) + a person's psql / the row-count script (2) + room (1)
  backend + beside <= usable

Pinned: the budget is computed from the files (compose.yml, env/<environment>.yaml, config.py) — a bigger pool that no longer fits, or a smaller one than the first day needed, turns this red; the runbook states the same numbers.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from app.core.config import Settings

_ROOT = Path(__file__).resolve().parents[2]
_VM = _ROOT / "deploy/vm"
SUPERUSER_RESERVED = 3          # postgres default superuser_reserved_connections
RAW_LISTEN = 1                  # pg_pubsub.listen_loop, outside the pools (app/core/database.py)
BESIDE = 2 + 1 + 2 + 1          # migrate + pg_dump + psql/row counts + room
FIRST_DAY_FLOOR = 30            # 5 + 5 = 10 was exhausted; three times that is the floor this change is for


def _max_connections() -> int:
    compose = yaml.safe_load((_VM / "compose.yml").read_text())
    command = compose["services"]["db"]["command"]
    values = [command[i + 1] for i, a in enumerate(command) if a == "-c" and command[i + 1].startswith("max_connections=")]
    assert len(values) == 1, command
    return int(values[0].split("=", 1)[1])


def _pools(environment: str) -> tuple[int, int]:
    decl = yaml.safe_load((_VM / "env" / f"{environment}.yaml").read_text())
    o = decl["services"]["backend"]["overrides"]
    return int(o["DB_POOL_SIZE"]), int(o["DB_MAX_OVERFLOW"])


@pytest.mark.parametrize("environment", ["dev", "prod"])
def test_the_request_pool_fits_the_database_budget_and_is_not_the_one_that_ran_dry(environment: str) -> None:
    size, overflow = _pools(environment)
    defaults = Settings()
    worker = defaults.worker_db_pool_size + defaults.worker_db_max_overflow
    usable = _max_connections() - SUPERUSER_RESERVED
    backend = size + overflow + worker + RAW_LISTEN
    assert backend + BESIDE <= usable, f"{environment}: the backend can hold {backend} + {BESIDE} beside it = {backend + BESIDE} > {usable} usable connections"
    assert size + overflow >= FIRST_DAY_FLOOR, f"{environment}: a request pool of {size} + {overflow} is what ran dry on the first day"


def test_the_numbers_the_test_uses_are_the_real_ones() -> None:
    assert _max_connections() == 60
    defaults = Settings()
    assert (defaults.worker_db_pool_size, defaults.worker_db_max_overflow) == (2, 1), "the worker pool the budget counts"
    database = (_ROOT / "backend/app/core/database.py").read_text()
    assert "pg_pubsub.listen_loop 상시 1" in database, "the raw LISTEN connection the budget counts"
    for environment in ("dev", "prod"):
        decl = yaml.safe_load((_VM / "env" / f"{environment}.yaml").read_text())
        assert str(decl["services"]["backend"]["overrides"]["DB_PGBOUNCER"]) == "false", "direct connections: every open session is a database connection"
        assert str(decl["services"]["backend"]["overrides"]["PG_LISTEN_ENABLED"]) == "true"


def test_the_runbook_states_the_budget_with_the_numbers_of_the_files() -> None:
    text = (_VM / "RUNBOOK.md").read_text()
    sec = text[text.index("## 11. "):]
    para = sec[sec.index("**Database connection budget.**"):sec.index("- **Changing an `env/<environment>.yaml` value")]
    size, overflow = _pools("dev")
    for needle in ("`max_connections=60`", "57 are usable", f"`DB_POOL_SIZE + DB_MAX_OVERFLOW` ({size} + {overflow} = {size + overflow})", "the worker pool (2 + 1 = 3)", "the raw `LISTEN` connection outside the pools (1)",
                   "— 34.", "(2), the backup's `pg_dump` (1), a person's `psql` or the row-count script (2), and room (1) — 6. 34 + 6 = 40 ≤ 57", "25 + 15 still fits: 44 + 6 = 50", "QueuePool limit", "pg_stat_activity"):
        assert needle in para, needle
    assert size + overflow + 3 + 1 == 34 and 34 + BESIDE == 40


def test_the_runbook_has_the_temporary_rebuilt_bundle_path_the_deployer_supports() -> None:
    text = (_VM / "RUNBOOK.md").read_text()
    sec = text[text.index("- **Changing an `env/<environment>.yaml` value"):]
    for needle in ("The private plain file cannot do it (overrides win over it)", "a rebuilt bundle of the SAME git sha", "--src <the unpacked folder>", "bundles/<sha>-rebuilt.tgz", "Undo: `gcloud storage cp ./desired.prev.json gs://$DEPLOY_BUCKET/desired.json`", "Put the value into the repository afterwards"):
        assert needle in sec, needle
    deployer = (_VM / "bin/deployer.py").read_text()
    assert "a folder from an earlier bundle of the SAME git sha (rebuilt, or damaged) is not reused" in deployer, "the deployer really supports it"
    assert 'if d["bundle"].startswith("/") or ".." in d["bundle"]:' in deployer, "and takes any object name for the bundle"
    render = (_VM / "bin/render_env.py").read_text()
    assert "private plain file (the live service's non-secret values)  <  overrides" in render
    assert re.search(r"--src", (_VM / "bin/make_bundle.py").read_text())
