#!/usr/bin/env python3
"""story #2293 — destructive_schema 파일(2026-07-28엔 94개·2026-09-03 실측 200개)을
CI 매트릭스 샤드로 나눈다.

왜: 순차 실행(파일마다 독립 fresh DB 생성/드롭 — story 8236bbc3)이 25분 천장에 붙었다
(PR #2576 conclusion=cancelled, 77/94까지 진행하고 잘림 — 실패는 0건, 시간만 모자랐다).
개별 테스트는 안 느리다 — 파일마다 붙는 dropdb/createdb/CREATE EXTENSION/create_all()
오버헤드가 누적된 것이 벽시계의 대부분이다. 샤딩은 그 오버헤드를 병렬로 나눈다(story
#3383은 ci.yml의 템플릿 DB 스텝으로 create_all() 반복 자체를 없애 오버헤드 크기 자체를
줄인다 — 이 파일의 배분 로직과는 직교하는 별개 처방, 둘 다 필요).

`infra/destructive-schema-shard-weights.json`(2026-07-28 스냅샷, 파일별 pytest 실행초)을
greedy LPT(Longest Processing Time first)로 읽어 균형 배분한다. 스냅샷에 없는 새 파일은
평균 가중치를 받는다 — ⛔discover(`pytest --collect-only`)가 항상 SSOT다. 스냅샷은 가중치
힌트일 뿐이라 새 파일이 스냅샷에 없다는 이유로 빠지는 일은 없다(파일 목록은 매번 실제
컬렉션에서 뽑고, 가중치만 스냅샷+평균값으로 보강한다).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
WEIGHTS_PATH = REPO_ROOT / "infra" / "destructive-schema-shard-weights.json"

_FILE_RE = re.compile(r"^tests/[a-zA-Z0-9_]+\.py")


def discover_files(backend_dir: Path = BACKEND_DIR) -> list[str]:
    """⚠️`--collect-only` 출력은 `tests/test_x.py::test_name` 형태(테스트 노드 단위)다 —
    ci.yml의 기존 bash 루프와 동일하게 파일 경로만 앞에서 추출한다(전체 라인이 파일명과
    같아야 한다는 순진한 가정을 했다가 처음엔 0건으로 깨졌다 — 실측 후 정정)."""
    out = subprocess.run(
        ["uv", "run", "pytest", "-q", "-m", "destructive_schema", "--collect-only"],
        cwd=backend_dir, capture_output=True, text=True, check=True,
    ).stdout
    files = sorted({
        m.group(0) for line in out.splitlines()
        if (m := _FILE_RE.match(line.strip()))
    })
    return files


def load_weights(weights_path: Path = WEIGHTS_PATH) -> dict[str, float]:
    if not weights_path.exists():
        return {}
    data = json.loads(weights_path.read_text())
    return {e["file"]: float(e["sec"]) for e in data.get("files", [])}


def check_staleness(discovered_count: int, weights_path: Path = WEIGHTS_PATH) -> str | None:
    """story #2293 후속(파울로군 지적, 2026-07-28) — 이 스냅샷은 실시간 측정이 아니다.
    스위트가 자라면 조용히 낡는다. 재측정 기준(a)만 여기서 자동 확인한다(파일 수 +20% —
    weights_path의 `_snapshot_policy`에 (b)(c) 수동 기준도 적혀 있다: 샤드 간 벽시계가
    1.5배 이상 벌어지거나 25분 천장 대비 여유가 다시 좁아지면 재측정)."""
    if not weights_path.exists():
        return None
    data = json.loads(weights_path.read_text())
    snapshot_total = data.get("total_files")
    if not snapshot_total:
        return None
    growth = (discovered_count - snapshot_total) / snapshot_total
    if growth >= 0.20:
        return (
            f"가중치 스냅샷({weights_path.name}, {data.get('measured_at', '?')} · "
            f"{snapshot_total}개) 대비 discover가 {discovered_count}개 — "
            f"+{growth * 100:.0f}% 증가. 재측정 권장(무거운 새 파일이 '평균 가중치'로만 "
            f"잡혀 한 샤드에 쏠릴 수 있다)."
        )
    return None


def partition(files: list[str], weights: dict[str, float], shard_count: int) -> tuple[list[list[str]], list[float]]:
    """greedy LPT — 무거운 순으로 정렬해 매번 «지금 가장 가벼운 샤드」에 넣는다.
    ⭐이 함수는 무손실이다(모든 파일이 정확히 하나의 샤드에 들어간다) —
    test_shard_destructive_tests.py::test_partition_is_lossless_for_any_input이 이걸 고정한다."""
    if shard_count < 1:
        raise ValueError("shard_count must be >= 1")
    avg = (sum(weights.values()) / len(weights)) if weights else 1.0
    ordered = sorted(files, key=lambda f: weights.get(f, avg), reverse=True)
    shards: list[list[str]] = [[] for _ in range(shard_count)]
    totals = [0.0] * shard_count
    for f in ordered:
        i = totals.index(min(totals))
        shards[i].append(f)
        totals[i] += weights.get(f, avg)
    return shards, totals


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard-index", type=int, required=True)
    ap.add_argument("--shard-count", type=int, required=True)
    ap.add_argument("--print-summary", action="store_true", help="전체 샤드 분배를 stderr에 찍는다")
    args = ap.parse_args()
    if not (0 <= args.shard_index < args.shard_count):
        print(f"shard-index {args.shard_index}가 shard-count {args.shard_count} 범위 밖", file=sys.stderr)
        return 2

    files = discover_files()
    weights = load_weights()
    shards, totals = partition(files, weights, args.shard_count)

    staleness = check_staleness(len(files))
    if staleness:
        print(f"⚠️ {staleness}", file=sys.stderr)

    if args.print_summary:
        print(f"discovered {len(files)} destructive_schema files total (discover가 SSOT)", file=sys.stderr)
        for i, (s, t) in enumerate(zip(shards, totals)):
            print(f"  shard {i}: {len(s)} files, ~{t:.1f}s(weighted estimate)", file=sys.stderr)
        assigned = sum(len(s) for s in shards)
        print(f"  합계: {assigned}/{len(files)} 배정(무손실 확인)", file=sys.stderr)

    for f in shards[args.shard_index]:
        print(f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
