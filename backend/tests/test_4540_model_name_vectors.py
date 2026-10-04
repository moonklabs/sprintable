"""story 4540 (PO 2026-10-04 13:10Z · 13:11Z · Kadir 13:12Z) — the run profile's model-name rule: Claude may end with «[1m]» (its 1M-context
id, `claude-opus-5-5[1m]` — our launchers' value), that one tail only; Codex never. The vectors are one file with the same bytes in this
repo and the daemon's (sprintable-mobile desktop-host/test/fixtures/model-name-vectors.json); both pin its sha256, so an edit on one side
only goes red there. The rule is checked where it is enforced: the save (`check`) and the options the web reads (per runtime)."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.services.agent_run_profile import MODEL_NAME, check, options

VECTORS = Path(__file__).parent / "fixtures" / "model-name-vectors.json"
# the canonical bytes (the daemon's test pins the same value)
SHA256 = "1e34c68451ec01112de2f09a7f57c3f23a317bd8c15fd7e7c4cc93579f8d3e77"
RUNTIME = {"claude": "claude-code", "codex": "codex"}


def _vectors() -> list[dict]:
    return json.loads(VECTORS.read_text(encoding="utf-8"))["vectors"]


def test_the_vector_file_is_the_shared_one() -> None:
    assert hashlib.sha256(VECTORS.read_bytes()).hexdigest() == SHA256


@pytest.mark.parametrize("v", _vectors(), ids=lambda v: f"{v['runtime']}:{v['model'][:40]}:{v['ok']}")
def test_save_takes_exactly_the_vectors(v: dict) -> None:
    runtime = RUNTIME[v["runtime"]]
    if v["ok"]:
        check(runtime, v["model"], None)
    else:
        with pytest.raises(HTTPException) as e:
            check(runtime, v["model"], None)
        assert e.value.detail == {"code": "invalid_model"}


@pytest.mark.parametrize("v", _vectors(), ids=lambda v: f"{v['runtime']}:{v['model'][:40]}:{v['ok']}")
def test_options_give_each_runtime_its_own_rule(v: dict) -> None:
    entry = next(r for r in options()["runtimes"] if r["runtime"] == RUNTIME[v["runtime"]])
    assert bool(re.fullmatch(entry["model_pattern"], v["model"])) is v["ok"]


def test_the_top_level_pattern_stays_the_strictest() -> None:
    # a client that reads one pattern only must never let a tail through for Codex
    assert options()["model_pattern"] == MODEL_NAME.pattern
    assert not re.fullmatch(options()["model_pattern"], "claude-opus-5-5[1m]")
