#!/usr/bin/env bash
# story #3944(카디르 뮤테이션 테스트 지적, PR#4348 3라운드, 페드루 PO 판정) — destructive
# 샤드 job의 파일별 격리 루프(DB 재생성 + 정지감지 래퍼 호출 + exit 분류 + failed_files/
# overage_files 누적)를 ci.yml 인라인 YAML에서 이 스크립트로 뺐다.
#
# 전에는 ci-loop-errexit-survival.test.sh가 이 루프를 손으로 베껴 검증했다 — 「ci.yml만
# 옛(버그 있는) 구조로 되돌려도 그 사본 테스트는 여전히 ALL PASS」라는 못 틀리는 대조였다
# (카디르 재현). 이제 ci.yml과 테스트 둘 다 이 파일 하나를 그대로 부른다 — 이 파일 자체를
# 뮤테이션하면(예: if/then/else/fi를 다시 `wrapper; code=$?`로 되돌리면) 테스트가 실측으로
# 빨개진다.
#
# 사용법: run-destructive-shard-loop.sh <pytest_cmd_prefix...>
#   (예: run-destructive-shard-loop.sh uv run pytest -q)
#
# 필수 환경변수:
#   WRAPPER_SCRIPT     — run-with-stall-detection.sh 경로
#   STALL_TIMEOUT_MIN  — 파일 하나당 정지 감지 상한(분)
#   FILES_LIST_FILE    — 파일 목록(줄바꿈 구분) 경로
#   ELAPSED_OUT_FILE   — 파일별 "path\telapsed_seconds" 를 append할 경로(기존 파일에 이어씀)
#   FAILED_OUT_FILE    — 실패(STALL 포함)한 파일 설명을 한 줄씩 쓸 경로(덮어씀)
# 선택 환경변수(story #3392 AC1 unweighted 초과판정, 셋 다 있어야 판정 켜짐):
#   UNWEIGHTED_FILES_FILE — unweighted 파일 목록(줄바꿈 구분) 경로
#   OVERAGE_THRESHOLD_SEC — 초과판정선(초, 정수)
#   OVERAGE_MULTIPLIER    — 로그 메시지용 배율 문자열
#   OVERAGE_OUT_FILE      — 초과 판정된 파일 설명을 한 줄씩 쓸 경로(덮어씀)
#
# dropdb/createdb/PGPASSWORD는 PATH·환경에서 그대로 쓴다 — 프로덕션(ci.yml)에서는 실
# Postgres 클라이언트, 테스트에서는 fake stub(no-op)로 대체한다(cleanup-ci-artifacts.
# test.sh의 fake `gh` stub과 동형 패턴).
set -uo pipefail
# set -e를 여기서도 안 쓴다(#2293 철학 그대로) — 파일 하나의 비정상 종료가 이 루프
# 자체를 죽이면 나머지 파일은 "조용히 미실행"된 것과 같다. 대신 아래 각 판정은 명시적
# if/then/else로 직접 종료코드를 잡는다.

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <pytest_cmd_prefix...> (필수 env: WRAPPER_SCRIPT·STALL_TIMEOUT_MIN·FILES_LIST_FILE·ELAPSED_OUT_FILE·FAILED_OUT_FILE)" >&2
  exit 64
fi
: "${WRAPPER_SCRIPT:?WRAPPER_SCRIPT 필요}"
: "${STALL_TIMEOUT_MIN:?STALL_TIMEOUT_MIN 필요}"
: "${FILES_LIST_FILE:?FILES_LIST_FILE 필요}"
: "${ELAPSED_OUT_FILE:?ELAPSED_OUT_FILE 필요}"
: "${FAILED_OUT_FILE:?FAILED_OUT_FILE 필요}"

PYTEST_PREFIX=("$@")

mapfile -t files < "$FILES_LIST_FILE"
: > "$FAILED_OUT_FILE"

unweighted_files=()
overage_check_on=0
if [ -n "${UNWEIGHTED_FILES_FILE:-}" ] && [ -n "${OVERAGE_THRESHOLD_SEC:-}" ] && [ -n "${OVERAGE_OUT_FILE:-}" ]; then
  overage_check_on=1
  mapfile -t unweighted_files < "$UNWEIGHTED_FILES_FILE"
  : > "$OVERAGE_OUT_FILE"
fi

for f in "${files[@]}"; do
  echo "::group::isolated $f"
  PGPASSWORD="${PGPASSWORD:-sprintable}" dropdb -h localhost -U sprintable --if-exists sprintable_test_iso
  PGPASSWORD="${PGPASSWORD:-sprintable}" createdb -h localhost -U sprintable -T sprintable_test_tpl sprintable_test_iso
  _t0=$(date +%s)
  # 페드루 PO HIGH(PR#4348 재리뷰, 카디르 재현) — GHA `run:`는 기본 `bash -eo pipefail`
  # 이지만 이 스크립트는 set -e를 안 켰으므로 이 if 없이도 -e 문제는 없다 — 그래도
  # if/then/else 형태를 유지하는 건(이 스크립트가 언젠가 -e 켠 셸에서 source될 가능성을
  # 막는 방어) + 가독성 때문.
  if "$WRAPPER_SCRIPT" "$STALL_TIMEOUT_MIN" -- "${PYTEST_PREFIX[@]}" "$f"; then
    _pytest_exit=0
  else
    _pytest_exit=$?
  fi
  if [ "$_pytest_exit" -eq 124 ]; then
    echo "::error::STALL(story #3944) — $f 가 ${STALL_TIMEOUT_MIN}분 안에 안 끝나 강제 종료됨. 「오래 걸림」이 아니라 「멈춤」으로 판정 — 즉시 실패."
    echo "$f (STALL: exceeded ${STALL_TIMEOUT_MIN}m)" >> "$FAILED_OUT_FILE"
  elif [ "$_pytest_exit" -ne 0 ]; then
    echo "$f" >> "$FAILED_OUT_FILE"
  fi
  _elapsed=$(( $(date +%s) - _t0 ))
  echo "elapsed: ${_elapsed}s"
  printf '%s\t%s\n' "$f" "$_elapsed" >> "$ELAPSED_OUT_FILE"

  if [ "$overage_check_on" -eq 1 ]; then
    for uw in "${unweighted_files[@]+"${unweighted_files[@]}"}"; do
      if [ "$uw" = "$f" ] && [ "$_elapsed" -gt "$OVERAGE_THRESHOLD_SEC" ]; then
        echo "$f (${_elapsed}s > ${OVERAGE_THRESHOLD_SEC}s)" >> "$OVERAGE_OUT_FILE"
        echo "::error::unweighted 파일이 평균의 ${OVERAGE_MULTIPLIER:-?}배를 넘었다(story #3392 AC1): $f (${_elapsed}s > ${OVERAGE_THRESHOLD_SEC}s) — infra/destructive-schema-shard-weights/에 이 파일의 json을 추가하라."
      fi
    done
  fi
  echo "::endgroup::"
done
