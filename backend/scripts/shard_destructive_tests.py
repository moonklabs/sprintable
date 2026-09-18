#!/usr/bin/env python3
"""story #2293 — destructive_schema 파일(2026-07-28엔 94개·2026-09-03 실측 200개)을
CI 매트릭스 샤드로 나눈다.

왜: 순차 실행(파일마다 독립 fresh DB 생성/드롭 — story 8236bbc3)이 25분 천장에 붙었다
(PR #2576 conclusion=cancelled, 77/94까지 진행하고 잘림 — 실패는 0건, 시간만 모자랐다).
개별 테스트는 안 느리다 — 파일마다 붙는 dropdb/createdb/CREATE EXTENSION/create_all()
오버헤드가 누적된 것이 벽시계의 대부분이다. 샤딩은 그 오버헤드를 병렬로 나눈다(story
#3383은 ci.yml의 템플릿 DB 스텝으로 create_all() 반복 자체를 없애 오버헤드 크기 자체를
줄인다 — 이 파일의 배분 로직과는 직교하는 별개 처방, 둘 다 필요).

`infra/destructive-schema-shard-weights/`(디렉터리, 파일마다 정확히 하나의 `<test_file>.json`
— 2026-07-28 스냅샷, 파일별 pytest 실행초)을 greedy LPT(Longest Processing Time first)로
읽어 균형 배분한다. 스냅샷에 없는 새 파일은 평균 가중치를 받는다 — ⛔discover(`pytest
--collect-only`)가 항상 SSOT다. 스냅샷은 가중치 힌트일 뿐이라 새 파일이 스냅샷에 없다는
이유로 빠지는 일은 없다(파일 목록은 매번 실제 컬렉션에서 뽑고, 가중치만 스냅샷+평균값으로
보강한다).

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
# story #3812 CHANGES(재설계, 페드루 PO 근본처방 2026-09-12) — JSONL+`.gitattributes
# merge=union`(1차 처방)은 로컬 rebase/merge 충돌은 0으로 만들었으나(카드 97d15c85 AC1
# 실증), **GitHub의 서버측 merge(Squash and merge/Merge 버튼)는 커스텀 merge 드라이버를
# 안 따른다**는 것을 놓쳤다 — #4206이 develop에 착지한 뒤 #4209가 같은 파일에서
# CONFLICTING으로 남아 AC3 재판정이 FAIL(실사고, 2026-09-12). 「파일마다 정확히 한
# 줄」을 「파일마다 정확히 한 파일」로 한 단계 더 내리면 GitHub 서버측 merge에도 통한다
# — 서로 다른 새 파일 추가는 ADD/ADD 충돌 자체가 애초에 존재하지 않는 git의 구조적
# 성질이다(merge 드라이버 설정과 완전히 무관 — 이번 재설계의 핵심). 자주 안 바뀌는
# 메타(`_snapshot_policy`·`_drift_remeasure_procedure`·`measured_at`)는 여전히 이
# 디렉터리 밖 별도 `.meta.json`에 둔다(드물게 손으로만 바뀌므로 충돌 위험이 낮다).
WEIGHTS_DIR = REPO_ROOT / "infra" / "destructive-schema-shard-weights"
WEIGHTS_META_PATH = REPO_ROOT / "infra" / "destructive-schema-shard-weights.meta.json"

_FILE_RE = re.compile(r"^tests/[a-zA-Z0-9_]+\.py")


class DuplicateShardWeightEntryError(Exception):
    """story #3812 — 디렉터리 방식(파일마다 정확히 하나의 물리 json 파일)에서도 논리
    맹점은 남는다: 서로 다른 두 물리 파일이 «같은» `file` 키 값을 등재하면(예: 복붙
    실수로 파일명을 다르게 지었는데 내용의 `file` 필드는 같은 값) git은 이걸 ADD/ADD
    충돌로 못 잡는다(파일명 자체는 다르니까) — fail-loud로 로드 시점에 잡는다."""


class ShardWeightFilenameMismatchError(Exception):
    """story #3812(카디르 QA 계약값 확認, 페드루 PO 2026-09-12) — 물리 파일명이 그
    내용의 `file` 필드와 어긋나면(예: `test_a.py.json`인데 내용은
    `{"file": "tests/test_b.py", ...}`) 사람이 손으로 보기 전엔 절대 안 드러난다 —
    복붙 실수·리네임 누락이 조용히 엉뚱한 파일의 가중치를 덮어쓰게 둘 수 있다.
    파일명=`Path(entry['file']).name + '.json'` 불변식을 로드 시점에 강제한다."""


def _load_full_data(weights_dir: Path = WEIGHTS_DIR, meta_path: Path | None = None) -> dict:
    """디렉터리(파일마다 정확히 하나의 `<test_file>.json`) + meta.json(드물게 바뀌는
    메타)을 옛 단일 JSON과 같은 `{"_snapshot_policy":..., "measured_at":...,
    "files": [...]}` 모양으로 합쳐 돌려준다 — 기존 소비처(load_weights/
    load_raw_entries/check_staleness) 셋 다 이 모양에 의존하므로 그 계약을 그대로
    지키면 호출부 변경이 0에 가깝다.

    `meta_path` 생략 시 `weights_dir`의 형제 파일(`<dirname>.meta.json`)로 유도한다
    (실 경로에선 정확히 WEIGHTS_META_PATH와 같은 이름이 나옴 — 우연이 아니라 테스트가
    tmp_path에 가짜 weights_dir을 쓸 때 실 레포의 meta.json을 실수로 안 집어먹게
    하는 의도적 설계, story #3812).

    디렉터리 안 각 `*.json` 파일은 정확히 하나의 JSON 객체(항목)를 담아야 한다 —
    파싱 실패(비JSON)는 그 파일명을 실어 fail-loud로 알린다(어느 파일이 깨졌는지
    바로 알 수 있게, 사후 JSONDecodeError보다 읽기 쉬운 메시지)."""
    if meta_path is None:
        meta_path = weights_dir.parent / f"{weights_dir.name}.meta.json"
    meta: dict = {}
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
    files: list[dict] = []
    seen: dict[str, tuple[str, dict]] = {}
    if weights_dir.exists():
        for entry_path in sorted(weights_dir.glob("*.json")):
            try:
                entry = json.loads(entry_path.read_text())
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"{entry_path.name}이 올바른 JSON이 아니다(story #3812): {exc}"
                ) from exc
            # story #3812 — 중복 검사를 파일명 검사보다 먼저 한다: 어긋난 이름의
            # 파일이 «실은 다른 항목의 중복»이면 그게 더 구체적이고 실행 가능한
            # 진단이다(이름 검사는 그 file 값을 처음 보는 항목에만 의미가 있다 —
            # 어차피 한 file 값에 유효한 이름은 하나뿐이라, 강제되고 나면 이 중복
            # 시나리오는 한 디렉터리 안에서 물리적으로 재현 불가능해지지만, 방어
            # 계층으로 남긴다: 완전 동일한 내용의 «무해한» 중복(cherry-pick 등)은
            # 두 번째 물리 파일의 이름을 검증하지 않는다 — 실 사고에서 그 두 번째
            # 사본은 임의 이름을 가질 수 있다).
            prior = seen.get(entry["file"])
            if prior is not None and prior[1] != entry:
                raise DuplicateShardWeightEntryError(
                    f"{prior[0]}·{entry_path.name} — 파일 {entry['file']!r}이 서로 다른 물리 "
                    f"json 파일 두 곳에 다른 항목으로 등재됐다(story #3812): {prior[1]} vs {entry}"
                )
            if prior is None:
                expected_name = Path(entry["file"]).name + ".json"
                if entry_path.name != expected_name:
                    raise ShardWeightFilenameMismatchError(
                        f"{entry_path.name} — 파일명이 내용의 file 필드({entry['file']!r})와 "
                        f"어긋난다(story #3812): {expected_name}으로 이름 지을 것."
                    )
                seen[entry["file"]] = (entry_path.name, entry)
                files.append(entry)
    return {**meta, "files": files}


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


def load_weights(weights_dir: Path = WEIGHTS_DIR) -> dict[str, float]:
    data = _load_full_data(weights_dir)
    return {e["file"]: float(e["sec"]) for e in data.get("files", [])}


def load_raw_entries(weights_dir: Path = WEIGHTS_DIR) -> list[dict]:
    """story #3465 — files[] 항목 원본(그대로, `source` 필드 포함) 반환. `load_weights()`는
    이미 `{file: sec}`로 평탄화해 `source`를 버리므로, 그 필드를 검증하려는 호출자는 이
    함수를 쓴다(load_weights()의 계약은 그대로 유지 — partition() 등 기존 소비처가 이
    변경으로 안 흔들린다)."""
    return _load_full_data(weights_dir).get("files", [])


def entries_missing_source(entries: list[dict]) -> list[str]:
    """story #3465 — 단일 `source_run` 문자열을 폐기하고 files[] 항목마다 `source`
    (provenance)를 필수로 바꾼 뒤의 존재 가드. 오늘(2026-09-04) 하루 rebase 충돌
    3회(#3797·#3800·#3802)가 전부 그 단일 문자열 한 줄을 여러 PR이 동시에 건드려
    난 것 — 항목별 필드면 다른 PR이 다른 줄을 건드려 충돌이 구조적으로 사라진다.
    값의 진위는 검증 안 함(존재 자체만, story 23bf1913의 unweighted_files_in()과
    동형 관례)."""
    return [e["file"] for e in entries if not str(e.get("source", "")).strip()]


def check_staleness(
    discovered_count: int, weights_dir: Path = WEIGHTS_DIR, *, unweighted_count: int = 0,
) -> str | None:
    """story #2293 후속(파울로군 지적, 2026-07-28) — 이 스냅샷은 실시간 측정이 아니다.
    스위트가 자라면 조용히 낡는다. 재측정 기준(a)만 여기서 자동 확인한다(파일 수 +20% —
    weights_dir의 `_snapshot_policy`에 (b)(c) 수동 기준도 적혀 있다: 샤드 간 벽시계가
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
    if not weights_dir.exists():
        return None
    data = _load_full_data(weights_dir)
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
        f"가중치 스냅샷({weights_dir.name}, {data.get('measured_at', '?')} · "
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


# story #3636(CI·소형, 페드루 PO 確定 2026-09-07) — 위 threshold는 **run 전체에 대한
# 하나의 flat 값**이라, 그 파일 자신의 등재 weight와 무관하게 모든 weighted 파일에
# 똑같이 적용된다. test_2813_gate_github_check_realdb.py(weight 45.0s, 실제로는 25개
# realdb 테스트가 매번 전체 스키마 create_all을 다시 태우는 무거운 파일)가 2026-09-07
# 하루에 두 번 거짓 빨강(72s>66.0s·131s>102.9s)을 냈다 — 그 파일 자신의 elapsed/weight
# 배율은 1.6·2.91로 평범한 편차인데, weight가 60s 근방/이상인 파일은 애초에 그
# 배율만으로도 flat 임계값을 밥먹듯 넘는 구조다(weight 자체가 threshold의 분모에
# 전혀 반영 안 됨). 이 축은 그 구조적 갭을 메운다: 파일 자신의 weight × 배수(3.0) 밑에
# 있으면 flat 임계값을 넘었어도 FAIL이 아니라 WARN으로 낮춘다(무거운 파일에 «자기
# 무게만큼의» 여유를 준다 — flat 임계값 자체를 못 믿는 게 아니라 무거운 파일에게만
# 추가 여유축을 얹는 것, AC6이 거부한 "배율 자체의 상한"과는 다른 축).
#
# ⚠️ 이 가드가 이제 놓치는 것(선언, story #3636 AC2): 등재 weight W인 파일이 flat
# 임계값은 넘되 W × 3.0 밑으로만 느려지면(예: test_2813 weight 45 → elapsed ≤135) FAIL이
# 아니라 WARN이다 — «무거운 파일이 자기 weight의 3배 이내로 느려지는」 회귀는 이제
# 잡지 못한다(WARN으로만 보임). weight가 가벼운 파일(예: 5.0)의 20배 회귀(test_
# genuinely_heavy_file_still_caught_when_runner_is_normal, 100.0s)는 5.0×3.0=15.0을
# 훨씬 넘어 여전히 FAIL — 이 축은 무거운 파일에만 좁게 적용된다.
HEAVY_FILE_OWN_WEIGHT_FAIL_MULTIPLIER = 3.0


def slow_files_normalized(
    elapsed_by_file: dict[str, float], weights: dict[str, float], *, base_seconds: float = 60.0,
) -> tuple[list[str], float, int]:
    """story #3396 — weighted 파일만 대상으로 러너 정규화 60초 가드를 판정한다.
    반환: (초과한 파일 목록·정렬, 실제로 쓴 판정선(초), 배율 표본 크기). unweighted
    파일은 대상에서 아예 빠진다(#3392가 별도로 담당 — 두 가드가 같은 파일을 다른
    기준으로 두 번 재는 혼선을 막는다).

    story #3636 — FAIL 판정은 flat threshold 초과 **AND** 그 파일 자신의 weight ×
    HEAVY_FILE_OWN_WEIGHT_FAIL_MULTIPLIER도 초과할 때만(무거운 파일 전용 여유축,
    위 상수 docstring 참고)."""
    ratios = weighted_ratios(elapsed_by_file, weights)
    threshold = normalized_slow_threshold_sec(ratios, base_seconds=base_seconds)
    slow = [
        f for f, elapsed in elapsed_by_file.items()
        if f in weights and elapsed > threshold
        and elapsed > weights[f] * HEAVY_FILE_OWN_WEIGHT_FAIL_MULTIPLIER
    ]
    return sorted(slow), threshold, len(ratios)


def warned_only_files_normalized(
    elapsed_by_file: dict[str, float], weights: dict[str, float], threshold: float, slow: list[str],
) -> list[str]:
    """story #3636 — flat threshold는 넘었지만 자기 weight×3.0 여유축에 막혀 FAIL에서
    빠진 파일(가시성용 — 실패 0, story #3558의 ratio_outliers와 동형으로 경고만)."""
    over_threshold = {f for f, elapsed in elapsed_by_file.items() if f in weights and elapsed > threshold}
    return sorted(over_threshold - set(slow))


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


# story #3558(CI·소형) — shard(5) 22분29초 사례(2026-09-06, #3910 CI): 원인이 신규
# 파일이 아니라 옛 파일 클러스터의 등재값 과소(4~10배)였다. `_check_elapsed_mode`(위,
# #3396)는 "이 run 자신의 중앙값 배율로 60초를 스케일"하는 *러너 정규화* 가드라
# 클러스터 전체가 같이 느려진 경우 정규화가 따라가 버려 개별 파일의 등재값 자체가
# 낡았다는 신호를 못 낸다 — 이 축은 그와 별개로 "등재값 대 실측"의 **절대 배율**을
# 그대로 보는 경고 전용 축(실패 0, story #3396의 실패 가드와 안 겹친다).
RATIO_WARN_HIGH_MULTIPLIER = 2.0
RATIO_WARN_LOW_MULTIPLIER = 0.5


def ratio_outliers(
    measured: dict[str, float], weights: dict[str, float], *,
    high_multiplier: float = RATIO_WARN_HIGH_MULTIPLIER, low_multiplier: float = RATIO_WARN_LOW_MULTIPLIER,
) -> list[dict]:
    """story #3558 — `measured`(산출물에서 병합된 실측 pytest 소요)와 `weights`(등재값)
    둘 다에 있는 파일만 대상으로 ratio=measured/weight를 낸다. ratio>=high_multiplier
    (과소 등재, 이 파일이 이 등재값 탓에 샤드를 무겁게 만들 수 있다) 또는 ratio<=
    low_multiplier(과대 등재, 반대로 다른 파일이 손해를 볼 수 있다)만 반환(정렬은
    ratio 내림차순 — 가장 심한 것부터). weights에 없는 파일(#3392의 unweighted 축이
    이미 담당)·measured에 없는 파일(그 샤드에 안 걸렸거나 산출물 누락)은 조용히
    건너뛴다 — 이 축은 "이미 등재된 값이 실측과 얼마나 벌어졌는가"만 본다."""
    outliers = []
    for file, elapsed in measured.items():
        weight = weights.get(file)
        if weight is None or weight <= 0:
            continue
        ratio = elapsed / weight
        if ratio >= high_multiplier or ratio <= low_multiplier:
            outliers.append({"file": file, "measured_sec": elapsed, "weight_sec": weight, "ratio": ratio})
    outliers.sort(key=lambda o: o["ratio"], reverse=True)
    return outliers


def write_durations_json(elapsed_by_file: dict[str, float], out_path: Path, *, shard: int) -> None:
    """story #3558 AC1 — 샤드별 순수 pytest 소요(DB 준비 제외, `_parse_elapsed_file`과
    같은 값)를 JSON 산출물로 낸다. ci.yml이 이 파일을 `actions/upload-artifact`로
    올린다(shard-durations-{shard})."""
    out_path.write_text(json.dumps({"shard": shard, "durations": elapsed_by_file}, indent=2, sort_keys=True))


def load_present_shard_numbers(artifact_dir: Path) -> set[int]:
    """story #3653(CI·가드, 페드루 PO 確定 2026-09-07) — `artifact_dir` 아래
    shard-durations-{n}.json이 실제로 있는 shard 번호만 모은다(`load_duration_
    artifacts`와 같은 파일을 다시 읽되, 이번엔 병합된 durations가 아니라 "이 shard가
    산출물을 남겼는가" 자체가 관심사). 그라운딩 확認 — 타임아웃으로 25분 천장에
    죽은 shard는 `--elapsed-to-json`(파일 루프 완주 뒤에만 도는 마지막 스텝)까지
    못 가 이 산출물 자체가 없다(부분 기록도 없다) — 이 함수가 그 부재를 shard
    번호 단위로 드러낸다."""
    present: set[int] = set()
    for p in sorted(artifact_dir.glob("*.json")):
        try:
            data = json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        shard = data.get("shard")
        if isinstance(shard, int):
            present.add(shard)
    return present


def missing_shards(present: set[int], *, expected_count: int) -> list[int]:
    """story #3653 — 0..expected_count-1(ci.yml matrix.shard와 동형 범위) 중
    `present`에 없는 번호를 정렬해 반환(재현성)."""
    return sorted(set(range(expected_count)) - present)


def load_duration_artifacts(artifact_dir: Path) -> dict[str, float]:
    """story #3558 AC2 — `artifact_dir` 아래 `*.json`(각 shard-durations-{n}.json,
    `{"shard": n, "durations": {file: sec}}` 모양) 전부를 하나의 {file: sec}로 병합한다.
    partition()이 무손실·배타적 분배를 보장하므로(test_partition_is_lossless_for_any_
    input) 파일이 두 샤드에 동시에 나타나는 정상 경로는 없다 — 방어적으로 나타나도
    마지막 값으로 덮어쓴다(에러로 죽이지 않는다, 이 축 자체가 경고 전용이라 원칙과 동형)."""
    merged: dict[str, float] = {}
    for p in sorted(artifact_dir.glob("*.json")):
        try:
            data = json.loads(p.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        merged.update(data.get("durations", {}))
    return merged


def _audit_durations_mode(
    artifact_dir: Path, *, drift_state_path: Path | None = None, run_id: str | None = None,
    expected_shard_count: int | None = None, shard_result: str | None = None,
    backend_relevant: str | None = None,
) -> int:
    """story #3558 AC2 — 원칙은 경고 전용(CI를 절대 안 죽인다). 산출물 디렉터리가
    없거나 비어 있어도(backend-irrelevant PR이라 샤드 자체가 스킵된 경우) 조용히
    "대조 대상 0건"으로 끝낸다.

    story #3642(AC3) — `drift_state_path`가 주어지면 «과소 등재(ratio≥2.0) 연속 스트릭»
    을 같이 추적한다(ci.yml이 actions/cache로 run 사이에 이 파일을 넘긴다).

    story #3642 CHANGES①(페드루 PO) — 산출물 디렉터리가 없어 조기 return하는 경로도
    drift 상태를 write-through(무변경 재저장)한다 — 안 그러면 ci.yml의 save 스텝
    (`if: always()`)이 존재하지 않는 경로를 캐시하려다 매 run "Path Validation
    Error"를 낸다(빨강이 배경음이 되는 자리, 이 스토리가 없애려는 바로 그 패턴).

    story #3642 CHANGES②(페드루 PO) — `run_id`가 주어지고 복원된 상태의 run_id와
    같으면(=같은 run의 재시도가 attempt 1이 이미 반영한 상태를 복원) 스트릭을 다시
    증가시키지 않는다(이중 카운트 방지, 멱등).

    story #3653(CI·가드, 페드루 PO 確定 2026-09-07) — 이 audit가 이제 ci.yml에서
    "Require all destructive-schema shards" **앞으로** 옮겨져 항상 돈다(그라운딩①,
    타임아웃/실패로 shard가 안 죽어도 이 audit는 실행돼야 다른 정상 shard의 실측이
    계속 집계된다). 그 재배치가 낳는 새 질문 — "산출물이 8개 미만이면 왜인가"를
    `expected_shard_count`/`shard_result`(ci.yml이 `needs.backend-test-destructive.
    result`를 그대로 넘긴다)로 가른다:
    - `shard_result == "success"`인데 산출물이 빠진 shard가 있으면 그건 코드 결함이
      아니라 **업로드 파이프라인 자체가 조용히 무산된 것**(예: upload-artifact 설정
      실수) — 침묵하면 안 되는 새로운 결함 클래스라 `::error`+**exit 1**(가드가
      "재료를 못 찾았다"고 스스로 빨개진다).
    - 그 외(실패·타임아웃·cancelled 등)는 그라운딩②의 결론 그대로 — 그 shard의
      실측 데이터가 원천적으로 없어(타임아웃이 파일 루프 중간을 끊으면 부분 기록도
      없다) "센다"가 물리적으로 불가능하다 — `::warning::`으로 "N개는 집계 밖"만
      선언(exit 0, 기존 경고-전용 원칙 그대로).

    story #3678(CI·핫픽스, 페드루 PO 確定 2026-09-07) — 위 `shard_result == "success"`
    분기가 놓친 세 번째 세계: FE-only PR은 `detect-changed-scope`가 backend_relevant=
    false를 내고, 그러면 ci.yml의 「Upload shard durations」 스텝 자체가 스킵된다
    (`if: ... && backend_relevant != 'false'`) — 8개 shard 잡은 각자 내부 스텝을 전부
    건너뛰고도 잡 자체는 `if: always()`라 "success"로 끝난다(스킵을 미실행이 아니라
    통과로 잡히게 하려는 의도된 설계, 위 주석 §3653 참고). 그 결과 "shard_result=
    success인데 산출물 8개 다 없다"가 **정상 경로**로 발생하는데, 위 분기는 이걸
    "업로드 파이프라인이 무산됐다"와 구분하지 못하고 그대로 ::error+exit 1을 낸다
    (실물: PR #4021 run 34160408234 잡 101860994039 — FE-only인데 Backend pytest
    전체가 이걸로 빨갛다). `backend_relevant`(ci.yml이 `needs.detect-changed-scope.
    outputs.backend_relevant`를 그대로 넘긴다)가 `"false"`면 shard_result·missing과
    무관하게 "스코프 밖·집계 대상 아님"만 선언하고 exit 0 — backend_relevant가
    `"false"`가 아닌 한(진짜 관련 PR) 위 §3653 판정은 그대로다(회귀 0).

    카디르 qa:changes(PR #4005, 2026-09-07, codex 발견) — 예전엔 `artifact_dir.exists()`
    가 이 shard_result 분기보다 **먼저** 서서, 디렉터리 자체가 통째로 없으면(업로드가
    전부 무산된 극단형) shard_result 무관하게 항상 조용히 0을 돌려줬다 — 부분 누락은
    잡는데 전체 누락은 새는 비대칭. `artifact_dir.glob("*.json")`(load_duration_
    artifacts·load_present_shard_numbers 둘 다)은 디렉터리가 없어도 빈 이터레이터를
    돌려줄 뿐 예외를 안 던지므로(파이썬 pathlib 표준 동작), 이 조기 return을 그냥
    없애면 아래 로직이 "산출물 0건"을 자연스럽게 흘려보내 밑의 `expected_shard_count`
    분기(shard_result 기준 error/warning)에 그대로 합류한다 — 전체 누락도 부분 누락과
    **같은 문구·같은 코드**를 탄다. drift 상태 write-through(story #3642 CHANGES①)도
    이 함수 중간에 무조건 도는 블록이라(위치 무변경) 이 삭제로 안 깨진다."""
    measured = load_duration_artifacts(artifact_dir)
    weights = load_weights()
    outliers = ratio_outliers(measured, weights)
    exit_code = 0

    if drift_state_path is not None:
        state = _load_drift_state(drift_state_path)
        if run_id is not None and state["run_id"] == run_id:
            streaks = state["streaks"]  # 같은 run 재시도 — 무변경 write-through.
        else:
            streaks = update_drift_streaks(state["streaks"], outliers)
            for f in drift_warnings(streaks):
                print(
                    f"::warning::weights drift(story #3642): {f} — 등재값이 {DRIFT_STREAK_THRESHOLD}"
                    f"run 연속 실측의 {RATIO_WARN_HIGH_MULTIPLIER:.0f}배 이상 벗어났다(러너가 느린 "
                    "하루가 아니라 등재값 자체가 낡았다는 신호) — infra/destructive-schema-shard-"
                    "weights/ 재측정 필요."
                )
                streaks[f] = 0  # story #3642 AC3 — 1회 경고 뒤 리셋(매 run 반복 스팸 방지).
        _save_drift_state(drift_state_path, run_id=run_id, streaks=streaks)

    if not outliers:
        print(f"OK: 등재값 대조 — 산출물 {len(measured)}건 중 2배/0.5배 이탈 0건(story #3558)", file=sys.stderr)
    else:
        for o in outliers:
            direction = "과소 등재" if o["ratio"] >= RATIO_WARN_HIGH_MULTIPLIER else "과대 등재"
            print(
                f"::warning::등재값 {direction}(story #3558): {o['file']} — 실측 {o['measured_sec']:.1f}s vs "
                f"등재 {o['weight_sec']:.1f}s(×{o['ratio']:.2f}) — infra/destructive-schema-shard-weights/ 재측정 검토."
            )
        print(f"경고 {len(outliers)}건(산출물 {len(measured)}건 중) — 실패 아님, story #3558 AC2", file=sys.stderr)

    if expected_shard_count is not None:
        missing = missing_shards(load_present_shard_numbers(artifact_dir), expected_count=expected_shard_count)
        if missing:
            if backend_relevant == "false":
                print(
                    f"OK: shard {len(missing)}개 산출물 없음(story #3678): {missing} — backend_relevant="
                    "false(FE-only 등 백엔드-무관 PR)라 8개 shard 모두 내부 스텝을 스킵하고 업로드 자체를 "
                    "안 했다(잡은 always()라 result=success로 끝나지만 그건 스킵의 「통과」일 뿐) — "
                    "스코프 밖·집계 대상 아님, 실패 아님."
                )
            elif shard_result == "success":
                print(
                    f"::error::shard 산출물 누락(story #3653): {missing} — backend-test-destructive.result="
                    "success인데 산출물이 없다(코드 결함 아님 — 업로드 파이프라인이 조용히 무산됐다는 뜻, "
                    "actions/upload-artifact 설정을 확認하라)."
                )
                exit_code = 1
            else:
                print(
                    f"::warning::shard {len(missing)}개는 드리프트 집계 밖(story #3653): {missing} — "
                    f"backend-test-destructive.result={shard_result!r}(타임아웃/실패)라 이 shard들의 실측 "
                    "데이터 자체가 없다(부분 기록도 없다) — 등재값 대조·drift 스트릭 어느 쪽도 이 shard를 "
                    "«못 봤다»는 뜻이지 «정상»이라는 뜻이 아니다."
                )
        else:
            print(f"OK: shard 산출물 {expected_shard_count}/{expected_shard_count} 전부 있음(story #3653)", file=sys.stderr)

    return exit_code


# story #3642(CI·소형, 3636 후속, 페드루 PO 確定 2026-09-07) — 3396의 러너 정규화는
# "이 run 자체가 느렸다"만 흡수한다. 등재값(weight)이 실측을 계속 밑도는 채로 여러
# run 연속이면(러너 편차로는 설명 안 됨) 등재값 자체가 낡은 것 — 그 신호를 3558의
# ratio_outliers(이미 ratio≥2.0을 "과소 등재"로 판정) 위에 «연속 카운트» 축 하나만
# 얹는다(새 판정 로직 0, 기존 축 재사용). ci.yml이 actions/cache로 이 상태를 run
# 사이에 넘긴다(단일 run 안에서는 이 축이 그냥 no-op).
DRIFT_STREAK_THRESHOLD = 3


def update_drift_streaks(streaks: dict[str, int], outliers: list[dict]) -> dict[str, int]:
    """story #3642 — 이번 run에서 과소 등재(ratio≥RATIO_WARN_HIGH_MULTIPLIER)인 파일만
    스트릭 +1. 나머지(이전엔 걸렸지만 이번엔 정상 — 러너 편차였다는 뜻)는 결과에서
    빠진다(=0으로 리셋, 다음 로드 시 .get(file, 0)). 과대 등재(ratio≤0.5) 축은 drift
    경고 대상이 아니다(반대 방향, #3558이 이미 별도 경고)."""
    over_files = {o["file"] for o in outliers if o["ratio"] >= RATIO_WARN_HIGH_MULTIPLIER}
    return {f: streaks.get(f, 0) + 1 for f in over_files}


def drift_warnings(streaks: dict[str, int], *, threshold: int = DRIFT_STREAK_THRESHOLD) -> list[str]:
    """threshold 이상 연속인 파일만(정렬 — 재현성)."""
    return sorted(f for f, n in streaks.items() if n >= threshold)


def _load_drift_state(path: Path) -> dict:
    """반환 {"run_id": str|None, "streaks": dict[str,int]}. 상태 파일이 없거나
    (첫 run·캐시 미스) 깨졌으면(방어적) 빈 상태로 시작한다 — 이 축 자체가 경고
    전용이라 최악의 경우 «드리프트 경고 1회 늦게 뜬다»뿐, CI를 죽이지 않는다.

    story #3642 CHANGES② — run_id를 같이 저장/복원해 같은 run의 재시도(attempt
    2+)가 attempt 1이 이미 반영한 스트릭을 또 증가시키는 이중 카운트를 막는다.
    구버전(플랫 {file: count} 상태 파일)도 read하면 streaks로 그대로 승격
    (run_id=None — 다음 저장부터 새 모양)."""
    if not path.exists():
        return {"run_id": None, "streaks": {}}
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return {"run_id": None, "streaks": {}}
    if "streaks" not in data:
        return {"run_id": None, "streaks": data}
    return {"run_id": data.get("run_id"), "streaks": data.get("streaks", {})}


def _save_drift_state(path: Path, *, run_id: str | None, streaks: dict[str, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"run_id": run_id, "streaks": streaks}, indent=2, sort_keys=True))


def _check_elapsed_mode(elapsed_path: Path) -> int:
    """story #3396 — ci.yml의 pytest 루프가 이 샤드의 모든 파일을 다 돈 뒤 한 번
    호출한다(중앙값은 그 run 전체 표본이 있어야 나온다 — 파일 단위 즉시 판정이 애초에
    불가능한 가드다)."""
    elapsed_by_file = _parse_elapsed_file(elapsed_path)
    weights = load_weights()
    slow, threshold, sample_size = slow_files_normalized(elapsed_by_file, weights)

    # story #3636 — weight×3.0 여유축에 막혀 FAIL에서 빠진 파일도 조용히 넘기지 않고
    # WARN으로 남긴다(가시성 — story #3558 ratio_outliers와 동형 관례).
    for f in warned_only_files_normalized(elapsed_by_file, weights, threshold, slow):
        print(
            f"::warning::러너 정규화 가드 — {f} 임계값({threshold:.1f}s) 초과했지만 자기 weight"
            f"({weights[f]:.1f}s)×{HEAVY_FILE_OWN_WEIGHT_FAIL_MULTIPLIER:.1f} 이내라 WARN만(story #3636): "
            f"{elapsed_by_file[f]:.0f}s"
        )

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
    ap.add_argument(
        "--shard-count", type=int, default=None,
        help="파티션 모드(--shard-index와 함께)의 샤드 수. story #3653 — --audit-durations "
             "모드에서도 재사용한다(새 인자 발명 0) — 산출물이 이 수만큼 다 있는지 대조한다.",
    )
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
    ap.add_argument(
        "--elapsed-to-json", nargs=2, type=Path, default=None, metavar=("ELAPSED_IN", "JSON_OUT"),
        help="story #3558 AC1 — --check-elapsed와 같은 <file>\\t<elapsed_sec> 파일을 읽어 "
             "{shard, durations} JSON으로 변환한다(actions/upload-artifact 산출물용). "
             "--shard와 함께 쓴다.",
    )
    ap.add_argument("--shard", type=int, default=None, help="--elapsed-to-json의 shard 번호")
    ap.add_argument(
        "--audit-durations", type=Path, default=None, metavar="ARTIFACT_DIR",
        help="story #3558 AC2 — ARTIFACT_DIR 아래 shard-durations-*.json 전부를 병합해 "
             "shard-weights/와 2배/0.5배 대조 경고를 낸다(항상 exit 0, 실패 없음).",
    )
    ap.add_argument(
        "--drift-state", type=Path, default=None, metavar="STATE_JSON",
        help="story #3642 AC3 — --audit-durations와 함께 쓴다. 과소 등재 연속 스트릭을 "
             "이 JSON에 읽고 쓴다(ci.yml이 actions/cache로 run 사이에 넘긴다). 생략하면 "
             "drift 축 자체가 no-op(3558 축은 그대로 동작).",
    )
    ap.add_argument(
        "--run-id", type=str, default=None,
        help="story #3642 CHANGES② — --drift-state와 함께 쓴다(ci.yml이 "
             "${{ github.run_id }}를 넘긴다). 복원된 상태의 run_id와 같으면(같은 run의 "
             "재시도) 스트릭을 다시 증가시키지 않는다 — 이중 카운트 방지.",
    )
    ap.add_argument(
        "--shard-result", type=str, default=None,
        help="story #3653 — --audit-durations와 함께 쓴다(ci.yml이 "
             "needs.backend-test-destructive.result를 그대로 넘긴다). --shard-count와 "
             "짝을 이뤄 «성공인데 산출물이 빈 shard」(업로드 결함, ::error+exit 1)와 "
             "「실패/타임아웃이라 원천적으로 못 세는 shard」(::warning만)를 가른다.",
    )
    ap.add_argument(
        "--backend-relevant", type=str, default=None,
        help="story #3678 — --audit-durations와 함께 쓴다(ci.yml이 "
             "needs.detect-changed-scope.outputs.backend_relevant를 그대로 넘긴다). "
             "'false'면 --shard-result와 무관하게 산출물 누락을 «스코프 밖»으로 선언하고 "
             "exit 0 — FE-only PR은 8개 shard 모두 업로드 자체를 스킵하는데도 잡은 "
             "always()라 result=success로 끝나, --shard-result만으로는(§3653) 이 케이스가 "
             "업로드 결함과 구분이 안 됐다.",
    )
    args = ap.parse_args()

    if args.check_elapsed is not None:
        return _check_elapsed_mode(args.check_elapsed)

    if args.elapsed_to_json is not None:
        elapsed_in, json_out = args.elapsed_to_json
        if args.shard is None:
            print("--elapsed-to-json은 --shard가 필수", file=sys.stderr)
            return 2
        write_durations_json(_parse_elapsed_file(elapsed_in), json_out, shard=args.shard)
        return 0

    if args.audit_durations is not None:
        return _audit_durations_mode(
            args.audit_durations, drift_state_path=args.drift_state, run_id=args.run_id,
            expected_shard_count=args.shard_count, shard_result=args.shard_result,
            backend_relevant=args.backend_relevant,
        )

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
