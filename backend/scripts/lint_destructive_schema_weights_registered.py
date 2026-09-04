#!/usr/bin/env python3
"""story 23bf1913(CI 후속, 페드루 PO 착수 2026-09-04) — 신규 destructive_schema 테스트
파일이 `infra/destructive-schema-shard-weights.json`에 미등재면 샤드 분배 **前** 별도
정적 체크에서 즉시 실패한다.

오늘(2026-09-04) 4건 PR(#3769·#3773·#3774·#3775) 전부 같은 사고를 반복했다 — 새
destructive 파일을 weights.json에 안 넣은 채 PR을 열면, story #3392의 unweighted 초과
가드(AC1, `shard_destructive_tests.py`)가 그 사실을 알려 주긴 하는데 **그 샤드가 파일을
전부 완주한 뒤에야**(~20분) 로그에 나타난다. 4 PR × 재커밋 1회 × 완주 대기 = 4×20분 낭비 —
전부 기능 결함 0건, 등재 누락뿐이었다.

이 가드는 그 20분을 기다리지 않는다 — `shard_destructive_tests.py`가 이미 갖고 있는
`discover_files()`(pytest --collect-only, ⛔discover가 항상 SSOT — 그 모듈 docstring
그대로)·`load_weights()`·`unweighted_files_in()`·`average_weight()`를 그대로 재사용해
(신규 판정 로직 발명 0) 별도 CI job에서 즉시 판정한다.

Postgres 불요 — `--collect-only`는 DB 연결이 없다(실측 확認, 로컬 `JWT_SECRET=x
SECRET_KEY=x pytest -m destructive_schema --collect-only` 14초 완주). 더미
JWT_SECRET/SECRET_KEY(설정값 검증 통과용, 실제 인증에는 안 쓰임)+uv sync만으로 끝난다 —
`backend-test-destructive`(8-way 매트릭스+Postgres+템플릿 DB 빌드) 전체를 기다릴 필요가
없다.

story #3465(CI 후속, 2026-09-04) — 두 번째 축 추가: files[] 항목마다 `source`
(provenance) 필드가 필수다(그 전엔 단일 `source_run` 문자열 하나에 전부 이어붙였다 —
하루(2026-09-04) rebase 충돌 3회(#3797·#3800·#3802)가 전부 그 한 줄을 여러 PR이 동시에
건드려 났다). `entries_missing_source()`가 그 존재만 본다(값의 진위는 검증 안 함, 아래
unweighted 축과 동형 관례).

⛔이 가드가 못 잡는 것(story #3392의 다른 가드와 축이 다르다 — 명시 선언, 다른 lint
스크립트들의 관례 그대로):
  · 이미 등재는 됐지만 실측치가 크게 틀린(낡은) 파일 — 그건 story #3392의 unweighted
    초과 가드(AC1, shard 완주 후 실측 대조)와 `check_staleness()`(파일 수 +20%) 몫이다.
    이 가드는 **존재 자체**만 본다("이 파일이 weights.json에 한 줄이라도 있나") — 그
    줄의 값이 맞는지는 검증하지 않는다.
  · weights.json에 등재된 파일이 나중에 destructive_schema 마커를 잃거나 파일명이
    바뀌는 경우 — `discover()`가 SSOT라 그 파일은 애초에 "신규 미등재" 목록에 안 잡히고,
    반대로 weights.json에 남은 죽은 항목은 이 가드가 지적하지 않는다(무해 —
    `partition()`이 그 항목을 그냥 안 쓸 뿐, story #3397이 이미 이 경로를 정리했다).

사용법: `python3 scripts/lint_destructive_schema_weights_registered.py`(backend/ cwd)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from shard_destructive_tests import (  # noqa: E402
    average_weight,
    discover_files,
    entries_missing_source,
    load_raw_entries,
    load_weights,
    unweighted_files_in,
)


def main() -> int:
    files = discover_files()
    weights = load_weights()
    missing = unweighted_files_in(files, weights)

    print(f"discover: destructive_schema 파일 {len(files)}개 · weights.json 등재 {len(weights)}개")

    # story #3465 — 단일 source_run 문자열 폐기 뒤 files[] 항목마다 source가 필수다.
    # unweighted 판정(위)보다 먼저 볼 이유는 없지만(둘 다 존재-가드, 순서 무관) 나란히
    # 실패를 한 번에 보고한다 — 재커밋 왕복을 줄인다(이 스크립트 자체의 존재 이유와
    # 동일 사상).
    no_source = entries_missing_source(load_raw_entries())
    if no_source:
        print(f"FAIL: source 필드가 비었거나 없는 files[] 항목 {len(no_source)}개(story #3465)")
        for f in no_source:
            print(f"::error::files[] 항목에 source가 없습니다(story #3465): {f}")

    if not missing and not no_source:
        print("OK: 신규 미등재 destructive_schema 파일 0건 · source 누락 0건")
        return 0

    if not missing:
        return 1

    avg = average_weight(weights)
    print(f"FAIL: shard-weights.json에 없는 destructive_schema 파일 {len(missing)}개(story 23bf1913)")
    print(
        "이대로 두면 샤드가 이 파일을 「평균 가중치」로만 배정하고, 실측이 평균의 3배를 "
        "넘으면(story #3392 AC1) 샤드 완주 뒤(~20분)에야 CI가 빨강이 됩니다."
    )
    print()
    print(
        "아래 조각을 infra/destructive-schema-shard-weights.json의 \"files\" 배열 끝에 "
        f"추가하세요(sec 값은 평균 가중치 {avg:.1f}s로 채웠습니다 — 실측치로 바꾸는 편이 "
        "낫습니다, scripts/measure_destructive_durations_local.py 참고):"
    )
    print()
    for f in missing:
        print(json.dumps({"file": f, "sec": round(avg, 1)}, ensure_ascii=False) + ",")
        print(f"::error::destructive_schema 파일이 shard-weights.json에 없습니다(story 23bf1913): {f}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
