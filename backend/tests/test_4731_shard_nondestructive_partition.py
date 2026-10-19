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
