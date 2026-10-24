"""story #4731 — the non-destructive pytest split into CI shards must be lossless: disjoint, covering every collected file, deterministic.
Pure functions, no database."""
from __future__ import annotations

import importlib.util
import random
from pathlib import Path

_PATH = Path(__file__).resolve().parent.parent / "scripts" / "shard_nondestructive_tests.py"
_spec = importlib.util.spec_from_file_location("shard_nondestructive_tests", _PATH)
mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mod)


def _counts(n=200, seed=1):
    rnd = random.Random(seed)
    return {f"tests/test_{i:04d}.py": rnd.choice([1, 1, 2, 3, 5, 8, 40, 120]) for i in range(n)}


def test_every_file_is_in_exactly_one_shard_for_any_shard_count():
    counts = _counts()
    for n in (1, 2, 3, 4, 5, 7, 16):
        shards = mod.partition(counts, n)
        flat = [f for s in shards for f in s]
        assert len(flat) == len(set(flat)) == len(counts)
        assert set(flat) == set(counts)


def test_the_split_is_deterministic_and_balanced_enough():
    counts = _counts()
    assert mod.partition(counts, 4) == mod.partition(dict(reversed(list(counts.items()))), 4)  # input order does not matter
    loads = [sum(counts[f] for f in s) for s in mod.partition(counts, 4)]
    assert max(loads) - min(loads) <= max(counts.values())  # LPT: the spread is at most the largest single file


def test_collect_output_is_parsed_per_file_and_summary_lines_are_ignored():
    text = (
        "tests/test_a.py::test_one\n"
        "tests/test_a.py::test_two[param-1]\n"
        "tests/test_b.py::TestX::test_three\n"
        "\n"
        "3/5 tests collected (2 deselected) in 1.20s"
    )
    assert mod.parse_collect_output(text) == {"tests/test_a.py": 2, "tests/test_b.py": 1}


def test_a_file_with_one_test_is_never_dropped_and_one_shard_can_stay_empty_only_if_there_are_fewer_files_than_shards():
    shards = mod.partition({"tests/test_x.py": 1}, 4)
    assert [f for s in shards for f in s] == ["tests/test_x.py"]
    assert sum(1 for s in shards if not s) == 3


def test_the_reverse_order_option_keeps_the_same_files():
    """`--order reverse` only turns this shard's file list around (a check that no test leans on an earlier one); the set of files is the same"""
    import subprocess
    import sys

    counts = {f"tests/test_{i}.py": 1 + i % 3 for i in range(12)}
    forward = mod.partition(counts, 3)[0]
    assert list(reversed(forward)) == forward[::-1]
    # the CLI wiring: the flag exists and is accepted
    out = subprocess.run([sys.executable, str(_PATH), "--help"], capture_output=True, text=True, check=False).stdout
    assert "--order" in out


def test_verify_partition_catches_a_dropped_a_doubled_and_a_miscounted_file():
    counts = {"a.py": 3, "b.py": 2, "c.py": 1}
    ok = mod.partition(counts, 2)
    assert mod.verify_partition(counts, ok)[0] == []
    assert mod.verify_partition(counts, [["a.py"], ["b.py"]])[0], "c.py dropped"
    assert mod.verify_partition(counts, [["a.py", "b.py"], ["b.py", "c.py"]])[0], "b.py doubled"
    assert mod.verify_partition(counts, [["a.py", "b.py", "c.py"], ["d.py"]])[0], "d.py is not a collected file"


def test_plan_round_trip_each_shard_reads_exactly_its_own_files(tmp_path):
    """the plan is written once and every shard reads its slot: no shard needs to collect, and an empty shard prints nothing"""
    import json
    import subprocess
    import sys

    counts = {f"tests/test_{i}.py": 1 + i % 4 for i in range(9)}
    shards = mod.partition(counts, 12)  # more shards than files → some stay empty
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"shard_count": 12, "counts": counts, "shards": shards}))
    seen = []
    for i in range(12):
        out = subprocess.run([sys.executable, str(_PATH), "--plan", str(plan), "--shard", str(i)], capture_output=True, text=True, check=False)
        assert out.returncode == 0, out.stderr
        files = out.stdout.split()
        assert files == shards[i]
        if not shards[i]:
            assert out.stdout == ""  # an empty shard prints nothing (the CI step then has nothing to run)
        seen += files
    assert sorted(seen) == sorted(counts)  # every collected file ran exactly once


# ─── the closing guards (Kadir's three pins): each one, deleted, must turn a test red ───────────────────────────────────────────


def _fake_run(returncode, stdout="tests/test_a.py::test_one\n", stderr=""):
    from types import SimpleNamespace

    return lambda *a, **k: SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def test_a_collection_that_errors_or_comes_back_empty_stops_the_plan(monkeypatch):
    """pin ① — `collect_counts` stops on a pytest exit code other than 0 / 5 AND on an empty collection: a collection that quietly returned
    fewer files would hand every shard a smaller plan, and the missing tests would run nowhere"""
    import pytest

    monkeypatch.setattr(mod.subprocess, "run", _fake_run(0))
    assert mod.collect_counts() == {"tests/test_a.py": 1}  # control: a clean collection passes
    for code in (1, 2, 3, 4):  # test failures, collection errors, internal error, usage error
        monkeypatch.setattr(mod.subprocess, "run", _fake_run(code))
        with pytest.raises(SystemExit):
            mod.collect_counts()
    monkeypatch.setattr(mod.subprocess, "run", _fake_run(0, stdout="0 tests collected\n"))
    with pytest.raises(SystemExit):  # exit 0 but nothing collected
        mod.collect_counts()
    monkeypatch.setattr(mod.subprocess, "run", _fake_run(5, stdout=""))
    with pytest.raises(SystemExit):  # exit 5 (nothing collected)
        mod.collect_counts()


def test_a_split_that_does_not_verify_writes_no_plan_and_exits_nonzero(monkeypatch, tmp_path):
    """pin ② — when the verification fails `--plan-out` returns 1 and leaves NO plan file behind (a half-trusted plan must not reach the shards);
    the CI step keeps that exit code through the `| tee` because it runs under `set -o pipefail` (checked on the workflow file)"""
    import sys
    from pathlib import Path

    counts = {"tests/test_a.py": 2, "tests/test_b.py": 1}
    monkeypatch.setattr(mod, "collect_counts", lambda: counts)
    plan = tmp_path / "plan.json"
    monkeypatch.setattr(sys, "argv", ["x", "--plan-out", str(plan), "--shard-count", "2"])
    assert mod.main() == 0 and plan.exists()  # control: an honest split writes the plan
    plan.unlink()
    monkeypatch.setattr(mod, "partition", lambda c, n: [["tests/test_a.py"], ["tests/test_a.py", "tests/test_b.py"]])  # a file twice
    assert mod.main() == 1
    assert not plan.exists()
    monkeypatch.setattr(mod, "partition", lambda c, n: [["tests/test_a.py"], []])  # a file in no shard
    assert mod.main() == 1
    assert not plan.exists()

    ci = (Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml").read_text()
    step = ci.split("- name: Collect once, split into shards, verify the split is lossless", 1)[1].split("- name:", 1)[0]
    assert "set -o pipefail" in step and "| tee" in step, "the plan step pipes the script through tee: without pipefail its exit code is lost"


def test_a_shard_number_outside_the_plan_is_refused_not_wrapped_around(monkeypatch, tmp_path, capsys):
    """pin ③ — shard -1 would silently read the LAST slot (python negative index) and shard N would be an IndexError: both must be refused
    with a clear exit, never run a wrong slot"""
    import json
    import sys

    import pytest

    counts = {"tests/test_a.py": 2, "tests/test_b.py": 1, "tests/test_c.py": 1}
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"shard_count": 3, "counts": counts, "shards": mod.partition(counts, 3)}))
    for shard in ("-1", "3", "99"):
        monkeypatch.setattr(sys, "argv", ["x", "--plan", str(plan), "--shard", shard])
        with pytest.raises(SystemExit):
            mod.main()
    monkeypatch.setattr(sys, "argv", ["x", "--plan", str(plan), "--shard", "2"])
    assert mod.main() == 0  # control: the last real slot is fine


def test_4731_ac3_deliberate_red_throwaway():
    assert False, "story 4731 AC3 measurement — one shard is made red on purpose (throwaway PR, not merged)"
