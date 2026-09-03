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

story #3392(CI 후속, 2026-09-03) — PR #3742가 unweighted 신규 파일(평균 가중치로만
배정된) 하나 때문에 shard가 20분 timeout에 걸려 cancel됐는데, 그때까지 아무 로그도
"이 파일이 unweighted였다"를 말하지 않았다(develop 본류는 같은 시각 정상 — #3383 처방
자체는 살아 있다, 이건 별개의 사각). `check_staleness()`는 "파일 수 +20%"만 보므로 이
1건짜리 사각을 못 잡는다. 이 스크립트는 이제 각 샤드가 가진 unweighted 파일 목록·평균
가중치·(평균×배수) 초과 판정선을 `--meta-out`으로 내보내 ci.yml의 pytest 루프가 그
자리에서(파일 완주 즉시, 샤드 timeout보다 먼저) 실측 소요를 판정선과 대조하게 한다.

story #3396(CI 후속, 2026-09-03) — story #3383 AC5의 절대 60초 가드가 story #3393이
정식화한 "느린 러너 표본"(median 4.45x~max 12.18x)과 정면으로 부딪혔다: PR #3753 run
33773872963 shard 0에서 `test_3373_channel_connections.py`가 168s(가중치 20.1s=8.4x)로
60초 가드에 걸려 fail 났는데, **같은 shard의 다른 24개 파일도 전부** median 5.91x로
튀어 있었다(이 파일 하나가 갑자기 무거워진 게 아니라 그 run 자체가 느린 러너였다).
`--check-elapsed`가 이 정규화 판정을 담당한다 — weighted 파일만으로 그 run 자신의
elapsed/weight 중앙값 배율을 구해 60초 판정선을 스케일한다(느린 러너면 판정선도 같이
늘어 오탐이 안 나고, 러너가 정상인데 그 파일 하나만 느려진 진짜 회귀는 배율이 1 근처라
그대로 잡힌다). unweighted 파일은 이 배율 표본·판정 대상 모두에서 제외 — 그쪽은 이미
`--meta-out`의 unweighted 초과 가드(#3392)가 별도로 담당한다.
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
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


def check_staleness(
    discovered_count: int, weights_path: Path = WEIGHTS_PATH, *, unweighted_count: int = 0,
) -> str | None:
    """story #2293 후속(파울로군 지적, 2026-07-28) — 이 스냅샷은 실시간 측정이 아니다.
    스위트가 자라면 조용히 낡는다. 재측정 기준(a)만 여기서 자동 확인한다(파일 수 +20% —
    weights_path의 `_snapshot_policy`에 (b)(c) 수동 기준도 적혀 있다: 샤드 간 벽시계가
    1.5배 이상 벌어지거나 25분 천장 대비 여유가 다시 좁아지면 재측정).

    story #3392 — `unweighted_count`(discover된 파일 중 스냅샷에 없는 것) 신호를
    더한다. +20% 문턱과 별개 이유: 파일 «수»가 20% 안 늘어도 unweighted 파일 단 1개가
    무거우면(PR #3742 실사고) 그 샤드 하나가 한도를 넘길 수 있다 — 「비율」이 아니라
    「존재 자체」가 위험 신호다. ⛔partition()에서 unweighted 파일에 «평균» 대신 «최대»
    가중치를 가정하는 대안도 검토했으나 채택 안 함(PR 본문에 근거) — 가벼운 신규 파일까지
    최댓값으로 과대평가해 샤드 균형을 오히려 해칠 수 있고, 이 경고+ci.yml의 실측 가드
    (AC1/AC2)가 이미 "무거운 unweighted 파일"을 실측 그 자리에서 하드 실패로 잡는다.

    story #3397(CI 후속) — 스냅샷의 파일 개수는 이제 `total_files` 필드가 아니라
    `len(files)`에서 파생한다. `total_files`/`total_sec`는 `files` 배열에서 그대로
    계산 가능한 값인데 JSON에 별도로 기록해 뒀던 것이 원인이었다 — 서로 다른 PR이
    각자 파일을 추가하며 그 합계 필드를 각자 갱신해, git이 "같은 줄이 양쪽에서 다르게
    바뀜"으로 보고 매 PR 병합마다 충돌을 냈다(#3742·#3752 실사고, #3752는 하루에 2회).
    `files` 배열에 새 항목을 append만 하는 건 서로 다른 줄이라 자동 병합되므로, 파생
    가능한 합계 자체를 저장하지 않으면 이 충돌 소지가 원천 봉쇄된다."""
    if not weights_path.exists():
        return None
    data = json.loads(weights_path.read_text())
    snapshot_total = len(data.get("files", []))
    if not snapshot_total:
        return None
    growth = (discovered_count - snapshot_total) / snapshot_total
    reasons = []
    if growth >= 0.20:
        reasons.append(f"discover가 {discovered_count}개(+{growth * 100:.0f}%)")
    if unweighted_count >= 1:
        reasons.append(f"unweighted 파일 {unweighted_count}개(평균 가중치로만 배정됨)")
    if not reasons:
        return None
    return (
        f"가중치 스냅샷({weights_path.name}, {data.get('measured_at', '?')} · "
        f"{snapshot_total}개) 대비 " + " · ".join(reasons) +
        " — 재측정 권장(무거운 새 파일이 '평균 가중치'로만 잡혀 한 샤드에 쏠릴 수 있다)."
    )


def average_weight(weights: dict[str, float]) -> float:
    """단일 SSOT — partition()의 폴백값과 story #3392의 초과판정 임계값(AC1) 둘 다
    이 함수 하나를 쓴다. 두 곳에서 각자 계산하면 언젠가 갈라진다."""
    return (sum(weights.values()) / len(weights)) if weights else 1.0


# story #3392(AC1) — unweighted 파일의 실측 소요가 평균의 이 배수를 넘으면 경고가 아니라
# CI 실패로 알린다. 3.0을 고른 이유: 로컬 재측정(2026-09-03) 표본에서 파일별 소요 분산이
# 커도(19.6s~0.x s) 정상 범위 파일 대부분이 평균의 3배 밑이었다 — PR #3742의 실사고
# 파일(shard 3을 20m대로 끌어올린 그 파일)은 이 배수를 훨씬 넘었을 것으로 추정된다(실측
# 로그엔 파일별 소요가 안 남아 사후 재현은 못 했다 — 이 상수 자체가 그 재현 불가를
# 메우는 사전 가드다). 너무 낮으면 정상 편차도 실패로 잡고(과탐), 너무 높으면 실사고급도
# 통과시킨다(과소 탐지) — 재측정 표본이 쌓이면 이 상수도 근거와 함께 재조정한다.
UNWEIGHTED_OVERAGE_MULTIPLIER = 3.0


def unweighted_files_in(files: list[str], weights: dict[str, float]) -> list[str]:
    """discover된 파일 중 가중치 스냅샷에 없는 것만(순서 보존) — story #3392 AC1."""
    return [f for f in files if f not in weights]


# story #3396(AC3) — 이 표본 수 미만이면 중앙값을 못 믿고 절대 60초로 폴백한다. 3을
# 고른 이유: 중앙값이 "가운데 값"이 되려면 양옆에 최소 1개씩은 있어야 한다 — 표본 2개
# 이하는 사실상 평균과 다르지 않아 "이 run의 전형적인 배율"이라 부르기 이르다.
MIN_RATIO_SAMPLE = 3


def weighted_ratios(elapsed_by_file: dict[str, float], weights: dict[str, float]) -> list[float]:
    """story #3396(AC2) — weights에 있는(=weighted) 파일만으로 elapsed/weight 배율을
    낸다. unweighted 파일은 이 비율 자체가 "평균 가중치로 나눈 값"이라 그 파일의 진짜
    무게와 무관해 표본에 넣으면 배율 추정이 오염된다(#3392의 unweighted-폴백 오염과
    같은 함정) — 그 파일들의 슬로우 판정은 이미 #3392의 unweighted 초과 가드가 맡는다."""
    return [elapsed_by_file[f] / weights[f] for f in elapsed_by_file if f in weights and weights[f] > 0]


def normalized_slow_threshold_sec(ratios: list[float], *, base_seconds: float = 60.0) -> float:
    """story #3396(AC1/AC3) — 그 run 자신의 elapsed/weight 중앙값 배율로 60초를
    스케일한다. 표본이 MIN_RATIO_SAMPLE 미만이면 중앙값을 못 믿고 절대 60초로 폴백한다
    (PO 확定, 2026-09-03 15:59Z).

    AC6(무한정 관대해지는 사각) — 중앙값 배율 자체에 상한(예: #3393의 max 12.18x)을
    두는 것은 일부러 안 했다: 배율이 그 이상으로 튈 만큼 극단적으로 느린 run이면 이
    shard는 이 가드가 판정을 내리기 전에 이미 story #3393의 shard 전체 20분 timeout에
    걸려 cancel될 가능성이 높다(이 판정 자체가 루프 완주 «후»에만 실행되므로, 루프가
    끝까지 못 돌면 여기 도달하지 않는다) — 즉 "극단적으로 느린 run"은 이미 다른
    메커니즘(shard timeout)이 잡는다. 여기에 또 다른 절대 상한을 두면 이 스토리가
    없애려는 바로 그 "임의의 매직 넘버"를 하나 더 추가하는 셈이라 채택하지 않았다."""
    if len(ratios) < MIN_RATIO_SAMPLE:
        return base_seconds
    return statistics.median(ratios) * base_seconds


def slow_files_normalized(
    elapsed_by_file: dict[str, float], weights: dict[str, float], *, base_seconds: float = 60.0,
) -> tuple[list[str], float, int]:
    """story #3396 — weighted 파일만 대상으로 러너 정규화 60초 가드를 판정한다.
    반환: (초과한 파일 목록·정렬, 실제로 쓴 판정선(초), 배율 표본 크기). unweighted
    파일은 대상에서 아예 빠진다(#3392가 별도로 담당 — 두 가드가 같은 파일을 다른
    기준으로 두 번 재는 혼선을 막는다)."""
    ratios = weighted_ratios(elapsed_by_file, weights)
    threshold = normalized_slow_threshold_sec(ratios, base_seconds=base_seconds)
    slow = [f for f, elapsed in elapsed_by_file.items() if f in weights and elapsed > threshold]
    return sorted(slow), threshold, len(ratios)


def partition(files: list[str], weights: dict[str, float], shard_count: int) -> tuple[list[list[str]], list[float]]:
    """greedy LPT — 무거운 순으로 정렬해 매번 «지금 가장 가벼운 샤드」에 넣는다.
    ⭐이 함수는 무손실이다(모든 파일이 정확히 하나의 샤드에 들어간다) —
    test_shard_destructive_tests.py::test_partition_is_lossless_for_any_input이 이걸 고정한다."""
    if shard_count < 1:
        raise ValueError("shard_count must be >= 1")
    avg = average_weight(weights)
    ordered = sorted(files, key=lambda f: weights.get(f, avg), reverse=True)
    shards: list[list[str]] = [[] for _ in range(shard_count)]
    totals = [0.0] * shard_count
    for f in ordered:
        i = totals.index(min(totals))
        shards[i].append(f)
        totals[i] += weights.get(f, avg)
    return shards, totals


def _parse_elapsed_file(path: Path) -> dict[str, float]:
    """`<file>\\t<elapsed_sec>` 줄 형식(ci.yml의 pytest 루프가 파일 완주마다 append) —
    JSON이 아니라 이 형식을 고른 이유: bash에서 안전하게 append-only로 쓸 수 있는
    포맷이 그것뿐이다(JSON은 배열 닫는 대괄호를 매번 다시 써야 해 마지막에 잘리면
    깨진다)."""
    result: dict[str, float] = {}
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        file_name, _, elapsed = line.partition("\t")
        result[file_name] = float(elapsed)
    return result


def _check_elapsed_mode(elapsed_path: Path) -> int:
    """story #3396 — ci.yml의 pytest 루프가 이 샤드의 모든 파일을 다 돈 뒤 한 번
    호출한다(중앙값은 그 run 전체 표본이 있어야 나온다 — 파일 단위 즉시 판정이 애초에
    불가능한 가드다)."""
    elapsed_by_file = _parse_elapsed_file(elapsed_path)
    weights = load_weights()
    slow, threshold, sample_size = slow_files_normalized(elapsed_by_file, weights)

    if sample_size < MIN_RATIO_SAMPLE:
        print(
            f"러너 정규화 표본 {sample_size}개 < {MIN_RATIO_SAMPLE} — 절대 {threshold:.0f}초로 폴백(story #3396 AC3)",
            file=sys.stderr,
        )
    else:
        print(
            f"러너 정규화 판정선: {threshold:.1f}초(표본 {sample_size}개 · 중앙값 배율 "
            f"×{threshold / 60.0:.2f}, story #3396 AC1)",
            file=sys.stderr,
        )

    if slow:
        for f in slow:
            print(
                f"::error::러너 정규화 60초 가드 초과(story #3396): {f} "
                f"({elapsed_by_file[f]:.0f}s > {threshold:.1f}s — 같은 run의 다른 파일 대비로도 무거워졌다)"
            )
        return 1

    print(f"OK: 러너 정규화 가드 통과({sample_size}개 표본 기준)", file=sys.stderr)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--shard-index", type=int, default=None)
    ap.add_argument("--shard-count", type=int, default=None)
    ap.add_argument("--print-summary", action="store_true", help="전체 샤드 분배를 stderr에 찍는다")
    ap.add_argument(
        "--meta-out", type=Path, default=None,
        help="story #3392 — 이 샤드의 unweighted 파일 목록·평균 가중치·초과판정선을 JSON으로 "
             "써 둔다. ci.yml의 pytest 루프가 파일 완주 즉시(샤드 timeout보다 먼저) 대조한다.",
    )
    ap.add_argument(
        "--check-elapsed", type=Path, default=None,
        help="story #3396 — <file>\\t<elapsed_sec> 줄로 된 파일을 읽어 러너 정규화 60초 "
             "가드를 판정하고 끝낸다(discover/partition 없음 — ci.yml의 pytest 루프가 이 "
             "샤드의 모든 파일을 다 돈 뒤 한 번 호출한다, 중앙값은 그 run 전체를 봐야 나온다).",
    )
    args = ap.parse_args()

    if args.check_elapsed is not None:
        return _check_elapsed_mode(args.check_elapsed)

    if args.shard_index is None or args.shard_count is None:
        print("--shard-index/--shard-count는 --check-elapsed 없이는 필수", file=sys.stderr)
        return 2
    if not (0 <= args.shard_index < args.shard_count):
        print(f"shard-index {args.shard_index}가 shard-count {args.shard_count} 범위 밖", file=sys.stderr)
        return 2

    files = discover_files()
    weights = load_weights()
    shards, totals = partition(files, weights, args.shard_count)

    this_shard = shards[args.shard_index]
    unweighted_all = unweighted_files_in(files, weights)
    unweighted_this_shard = unweighted_files_in(this_shard, weights)
    avg = average_weight(weights)
    overage_threshold = avg * UNWEIGHTED_OVERAGE_MULTIPLIER

    staleness = check_staleness(len(files), unweighted_count=len(unweighted_all))
    if staleness:
        print(f"⚠️ {staleness}", file=sys.stderr)

    # story #3392(AC1) — "로그 상단에 낸다(0건이면 그 사실도)": PR #3742가 unweighted 파일
    # 하나로 shard timeout에 걸렸을 때 이 정보 자체가 로그 어디에도 없었다.
    if unweighted_this_shard:
        print(
            f"이 샤드({args.shard_index}) unweighted 파일 {len(unweighted_this_shard)}개"
            f"(평균 가중치 {avg:.2f}s로 배정됨, 실측 소요가 {overage_threshold:.1f}s를 넘으면 "
            f"CI가 실패한다): {', '.join(unweighted_this_shard)}",
            file=sys.stderr,
        )
    else:
        print(f"이 샤드({args.shard_index}) unweighted 파일 0건", file=sys.stderr)

    if args.print_summary:
        print(f"discovered {len(files)} destructive_schema files total (discover가 SSOT)", file=sys.stderr)
        for i, (s, t) in enumerate(zip(shards, totals)):
            print(f"  shard {i}: {len(s)} files, ~{t:.1f}s(weighted estimate)", file=sys.stderr)
        assigned = sum(len(s) for s in shards)
        print(f"  합계: {assigned}/{len(files)} 배정(무손실 확인)", file=sys.stderr)

    if args.meta_out is not None:
        args.meta_out.write_text(json.dumps({
            "avg_weight_sec": avg,
            "unweighted_overage_multiplier": UNWEIGHTED_OVERAGE_MULTIPLIER,
            "unweighted_overage_threshold_sec": overage_threshold,
            "unweighted_files": unweighted_this_shard,
        }))

    for f in shards[args.shard_index]:
        print(f)
    return 0


if __name__ == "__main__":
    sys.exit(main())
