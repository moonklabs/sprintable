#!/usr/bin/env python3
"""story #4731 — split the non-destructive backend pytest into CI matrix shards.

Why: `backend-test-work` ran the whole non-destructive suite on one runner under `timeout-minutes: 25`, and the suite grew to 22–23 minutes
(25m15s on develop a3e7f8ac9 → «exceeded the maximum execution time» → the required `Backend pytest` red → the dev deploy stopped). Raising the
ceiling only moves the problem; the suite is split, the same tests, N runners.

How: every shard runs the SAME collection (`pytest --collect-only -q -m "not destructive_schema"`), counts the collected tests per FILE, and assigns
whole files to shards with greedy LPT (largest first, to the least-loaded shard; ties broken by name / shard index), so the split is a pure function of
the collected set — identical on every shard without any shared state, and lossless by construction: the files of all shards are exactly the files that
have at least one collected test (a file is never cut in two; a test is never dropped because it is missing from a snapshot).

  --shard I --shard-count N      print this shard's test files (one per line)
  --verify --shard-count N       collect once more, check that the N shards are disjoint and their union is the whole collected set, print the
                                  per-shard file / test counts (exit 1 otherwise)
  --counts-out FILE              (with --shard) also write {"shard": I, "files": F, "tests": T} for the run summary
  --order name|reverse           the order of this shard's files (default: by name). `reverse` is for checking that no test leans on an earlier
                                  one — a green run in the reverse order is part of the evidence for a change to the split.

The number of tests per file is a proxy for its time (the suite is mostly small real-DB tests); the measured per-shard times are in the PR / story.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
_NODE_RE = re.compile(r"^(?P<file>[^\s:]+\.py)::")


def parse_collect_output(text: str) -> dict[str, int]:
    """`pytest --collect-only -q` node-id lines → {file: collected test count}"""
    counts: dict[str, int] = {}
    for line in text.splitlines():
        m = _NODE_RE.match(line.strip())
        if m:
            counts[m.group("file")] = counts.get(m.group("file"), 0) + 1
    return counts


def partition(counts: dict[str, int], shard_count: int) -> list[list[str]]:
    """greedy LPT over files: deterministic, disjoint, and the union is exactly `counts`' files"""
    if shard_count < 1:
        raise ValueError("shard_count must be >= 1")
    loads = [0] * shard_count
    shards: list[list[str]] = [[] for _ in range(shard_count)]
    for name, weight in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        i = min(range(shard_count), key=lambda k: (loads[k], k))
        shards[i].append(name)
        loads[i] += weight
    return [sorted(s) for s in shards]


def collect_counts() -> dict[str, int]:
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", "-m", "not destructive_schema"],
        cwd=BACKEND_DIR, capture_output=True, text=True, check=False,
    )
    counts = parse_collect_output(proc.stdout)
    if proc.returncode not in (0, 5) or not counts:  # 5 = no tests collected → also a failure here
        sys.stderr.write(proc.stdout[-4000:] + proc.stderr[-4000:])
        raise SystemExit(f"collection failed (exit {proc.returncode}, {len(counts)} files)")
    return counts


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--shard", type=int)
    ap.add_argument("--shard-count", type=int, required=True)
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--counts-out")
    ap.add_argument("--order", choices=("name", "reverse"), default="name")
    args = ap.parse_args()

    counts = collect_counts()
    shards = partition(counts, args.shard_count)

    if args.verify:
        flat = [f for s in shards for f in s]
        problems = []
        if len(flat) != len(set(flat)):
            problems.append("a file is in more than one shard")
        if set(flat) != set(counts):
            problems.append(f"union differs from the collected files: missing={sorted(set(counts) - set(flat))} extra={sorted(set(flat) - set(counts))}")
        total = sum(counts.values())
        per = [sum(counts[f] for f in s) for s in shards]
        if sum(per) != total:
            problems.append(f"test count differs: shards={sum(per)} collected={total}")
        for i, s in enumerate(shards):
            print(f"shard {i}: {len(s)} files, {per[i]} tests")
        print(f"collected: {len(counts)} files, {total} tests; shards: {len(flat)} files, {sum(per)} tests")
        if problems:
            for p in problems:
                print("FAIL:", p)
            return 1
        print("OK: the shards are disjoint and cover every collected test")
        return 0

    if args.shard is None or not 0 <= args.shard < args.shard_count:
        raise SystemExit("--shard must be in [0, shard-count)")
    mine = shards[args.shard]
    if args.order == "reverse":
        mine = list(reversed(mine))
    if args.counts_out:
        Path(args.counts_out).write_text(json.dumps({"shard": args.shard, "files": len(mine), "tests": sum(counts[f] for f in mine)}))
    sys.stdout.write("\n".join(mine) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
