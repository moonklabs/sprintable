#!/usr/bin/env bash
# story #3944 CHANGES②(페드루 PO, PR#4348 리뷰 2라운드) — 「양성대조 +1」: 합성 파일 2개
# (첫째=exit 1 일반 실패·둘째=정상 통과)를 돌려 destructive-shard 루프가 GHA `run:` 기본
# 셸(`bash -eo pipefail`) 아래서도 첫 파일 실패 뒤 죽지 않고 둘째 파일까지 도는지, 그리고
# failed_files가 정확히 그 1건만 잡는지 실측한다.
#
# run-with-stall-detection.test.sh는 래퍼 스크립트 자신(timeout/exit 124 분류)만 검증한다
# — 이번 HIGH는 그 래퍼를 "부르는 쪽"(ci.yml 루프)의 -e 생존 여부였으므로 별도 파일로 뗐다.
#
# 주의: 아래 루프 바디는 .github/workflows/ci.yml의 backend-test-destructive 스텝에서
# postgres 재생성·uv·pytest·shard-weight 판정 등 실환경 의존 부분을 걷어낸 최소 재현이다.
# 그 스텝의 if/ALEMBIC_DATABASE_URL 등 env 접두/then/else/fi 구조를 바꾸면 이 파일도 손으로
# 맞춰야 한다(자동 추출 동기화 아님 — 구조 자체가 바뀌면 이 테스트도 같이 갱신할 것).
set -euo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/fake-wrapper.sh" <<'EOF'
#!/usr/bin/env bash
# run-with-stall-detection.sh의 실 계약(<timeout_min> -- <command...>)만 흉내낸 스텁 —
# 정지 감지 자체는 run-with-stall-detection.test.sh가 이미 커버하므로 여기선 그냥 통과실행.
shift 2
exec "$@"
EOF
chmod +x "$WORK/fake-wrapper.sh"

cat > "$WORK/fake-pytest.sh" <<'EOF'
#!/usr/bin/env bash
[ "$1" = "fail.py" ] && exit 1
exit 0
EOF
chmod +x "$WORK/fake-pytest.sh"

files=(fail.py pass.py)
failed_files=()
STALL_TIMEOUT_MIN=8
reached=()

for f in "${files[@]}"; do
  reached+=("$f")
  # ci.yml 실제 구조 재현 — env 접두는 if 자신이 아니라 그 조건절 simple command에 붙는다.
  if DUMMY_ENV_PREFIX=probe \
     "$WORK/fake-wrapper.sh" "$STALL_TIMEOUT_MIN" -- "$WORK/fake-pytest.sh" "$f"; then
    _pytest_exit=0
  else
    _pytest_exit=$?
  fi
  if [ "$_pytest_exit" -eq 124 ]; then
    failed_files+=("$f (STALL: exceeded ${STALL_TIMEOUT_MIN}m)")
  elif [ "$_pytest_exit" -ne 0 ]; then
    failed_files+=("$f")
  fi
done

FAIL=0
if [ "${#reached[@]}" -eq 2 ] && [ "${reached[1]}" = "pass.py" ]; then
  echo "  ok   fail.py(exit 1) 뒤에도 -e가 스텝을 안 죽이고 pass.py까지 루프 진행"
else
  echo "  FAIL 루프가 두번째 파일에 도달 못함 — reached=${reached[*]:-<empty>}"
  FAIL=1
fi

if [ "${#failed_files[@]}" -eq 1 ] && [ "${failed_files[0]}" = "fail.py" ]; then
  echo "  ok   failed_files에 fail.py 정확히 1건만 기록(pass.py는 안 들어감)"
else
  echo "  FAIL failed_files=${failed_files[*]:-<empty>}(기대: fail.py 1건)"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "FAILURES ABOVE"
  exit 1
fi
