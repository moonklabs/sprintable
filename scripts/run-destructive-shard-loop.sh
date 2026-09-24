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
# story #4283(까디르) — 실패 기록을 못 쓰면(러너 디스크 가득 등) 호출부의 `[ -s FAILED_OUT_FILE ]`이 «실패 없음»으로 읽어
# 테스트 실패를 초록으로 가린다. 기록 실패는 끝까지 돈 뒤(#2293 — 나머지 파일은 계속 잰다) 이 스크립트의 종료 코드로
# 알린다 — 호출부는 파일 내용과 종료 코드를 둘 다 본다.
record_failed=0

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
  # 페드루 PO CHANGES(PR#4348 4라운드) — 이 스크립트는 -e를 안 켰으므로 dropdb/createdb가
  # 실패해도(예: 이전 파일이 남긴 커넥션 때문에 DROP DATABASE가 거부되는 등) 조용히
  # 지나가 이후 pytest가 절반짜리/없는 DB에서 돌다 실패한다 — 그 실패가 «이 파일의
  # 회귀»로 오진되고 진짜 원인(인프라)은 로그에 안 남는다. 여기서 즉시 잡아 죽인다 —
  # `exit 1`(이 스크립트 자체의 exit code)은 이 스크립트를 부르는 ci.yml 쪽 simple
  # command 호출 지점에서 GHA 기본 `bash -eo pipefail`(그 스텝 자신은 이 스크립트와
  # 별도 프로세스라 여전히 -e 활성)이 즉시 스텝을 죽인다 — 파일별 pytest 실패(항상 0
  # 반환, FAILED_OUT_FILE로만 누적)와 인프라 실패(이 스크립트 자체가 죽음)를 이렇게
  # 종료코드 층위에서 구분한다(실측: 별도 프로세스는 부모 -e를 안 물려받지만, 그
  # 프로세스의 최종 exit code가 0이 아니면 부모의 -e는 정상적으로 발동함 — `bash -c
  # 'set -e; ./child.sh; echo unreachable'`로 확인).
  PGPASSWORD="${PGPASSWORD:-sprintable}" dropdb -h localhost -U sprintable --if-exists sprintable_test_iso \
    || { echo "::error::STALL-무관 인프라 실패(story #3944) — $f 처리 前 dropdb sprintable_test_iso 재생성 실패"; exit 1; }
  PGPASSWORD="${PGPASSWORD:-sprintable}" createdb -h localhost -U sprintable -T sprintable_test_tpl sprintable_test_iso \
    || { echo "::error::STALL-무관 인프라 실패(story #3944) — $f 처리 前 createdb sprintable_test_iso 재생성 실패"; exit 1; }
  _t0=$(date +%s)
  # 페드루 PO HIGH(PR#4348 재리뷰, 카디르 재현) — 이 스크립트를 별도 프로세스로
  # 부르면(현재 ci.yml 호출 방식) -e가 안 상속돼 이 if 없이도 문제는 안 생긴다. 하지만
  # 이 if/then/else는 "이 파일이 어디서(-e 켜진 셸에 source되거나, 나중에 인라인으로
  # 되돌려지거나) 실행되든 지키는" 불변식으로 일부러 남긴다 — 파일 하나 실패가 나머지
  # 파일 실행을 막으면 안 된다는 계약은 호출 컨텍스트에 의존해서는 안 된다(#2293 철학).
  if "$WRAPPER_SCRIPT" "$STALL_TIMEOUT_MIN" -- "${PYTEST_PREFIX[@]}" "$f"; then
    _pytest_exit=0
  else
    _pytest_exit=$?
  fi
  if [ "$_pytest_exit" -eq 124 ]; then
    echo "::error::STALL(story #3944) — $f 가 ${STALL_TIMEOUT_MIN}분 안에 안 끝나 강제 종료됨. 「오래 걸림」이 아니라 「멈춤」으로 판정 — 즉시 실패."
    echo "$f (STALL: exceeded ${STALL_TIMEOUT_MIN}m)" >> "$FAILED_OUT_FILE" || record_failed=1
  elif [ "$_pytest_exit" -ne 0 ]; then
    echo "$f" >> "$FAILED_OUT_FILE" || record_failed=1
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

if [ "$record_failed" -ne 0 ]; then
  echo "::error::격리 루프가 실패 기록(FAILED_OUT_FILE)을 못 씀(story #4283) — 실패한 파일이 있는데 기록이 없다, 판정 불가라 RED"
  exit 1
fi
