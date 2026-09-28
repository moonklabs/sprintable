#!/usr/bin/env python3
"""story #4159 — story #3558 "전수 재측정 절차"의 CI측 대응물. `measure_destructive_
durations_local.py`(로컬, CI의 ~1/6 속도라 절대값으론 못 씀, story #3383 실측)와 달리
이 스크립트는 `gh run download`로 최근 성공한 ci.yml run들의 `shard-durations-*`
산출물(story #3558 AC1, `shard_destructive_tests.py::write_durations_json`이
`--elapsed-to-json`으로 낸 것)을 직접 받아 **CI 실측 절대값**을 파일별로 모은다.

사용법:
    uv run python scripts/collect_ci_shard_durations.py --limit 40 --out /tmp/ci_durations.json

산출 포맷: {file: {"max_sec": float, "count": int, "run_ids": [str, ...]}}
(count/run_ids = 몇 개 run에서 실측됐는지 — AC1 "관측 N건·run id 명기" 요구사항 그대로.)
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def _recent_successful_run_ids(*, repo: str, limit: int) -> list[str]:
    proc = subprocess.run(
        ["gh", "run", "list", "--repo", repo, "--workflow", "ci.yml", "--limit", str(limit),
         "--json", "databaseId,conclusion"],
        capture_output=True, text=True, check=True,
    )
    rows = json.loads(proc.stdout)
    return [str(r["databaseId"]) for r in rows if r.get("conclusion") == "success"]


def _download_shard_durations(*, repo: str, run_id: str, dest: Path) -> list[Path]:
    """이 run의 shard-durations-* 아티팩트를 dest 아래 받는다. FE-only PR 등 아티팩트
    자체가 없는 run은 gh가 비영(exit!=0)으로 실패하는데, 이 함수는 그걸 "관측 0건"으로
    조용히 넘긴다(경고 전용 원칙, _audit_durations_mode와 동형)."""
    proc = subprocess.run(
        ["gh", "run", "download", run_id, "--repo", repo, "-p", "shard-durations-*", "-D", str(dest)],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        return []
    return sorted(dest.glob("shard-durations-*/shard-durations-*.json"))


def collect(*, repo: str, limit: int) -> dict[str, dict[str, object]]:
    run_ids = _recent_successful_run_ids(repo=repo, limit=limit)
    print(f"대상 run(성공) {len(run_ids)}개: {run_ids}", file=sys.stderr)

    merged: dict[str, dict[str, object]] = {}
    with tempfile.TemporaryDirectory() as tmp:
        for i, run_id in enumerate(run_ids):
            dest = Path(tmp) / run_id
            files = _download_shard_durations(repo=repo, run_id=run_id, dest=dest)
            if not files:
                print(f"[{i+1}/{len(run_ids)}] run={run_id} 산출물 없음(FE-only 등) — 스킵", file=sys.stderr)
                continue
            per_run: dict[str, float] = {}
            for p in files:
                try:
                    data = json.loads(p.read_text())
                except (json.JSONDecodeError, OSError):
                    continue
                per_run.update(data.get("durations", {}))
            for f, sec in per_run.items():
                entry = merged.setdefault(f, {"max_sec": 0.0, "count": 0, "run_ids": []})
                entry["count"] = int(entry["count"]) + 1
                entry["run_ids"].append(run_id)  # type: ignore[union-attr]
                if sec > entry["max_sec"]:
                    entry["max_sec"] = sec
            print(f"[{i+1}/{len(run_ids)}] run={run_id} {len(per_run)}개 파일 실측 병합", file=sys.stderr)
    return merged


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="moonklabs/sprintable")
    ap.add_argument("--limit", type=int, default=40, help="조회할 최근 ci.yml run 수(성공만 필터)")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    merged = collect(repo=args.repo, limit=args.limit)
    args.out.write_text(json.dumps(merged, ensure_ascii=False, indent=2, sort_keys=True))
    print(f"OK: {len(merged)}개 파일 실측치 → {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
