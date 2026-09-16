#!/usr/bin/env bash
# story #3944 — 카디르 뮤테이션 테스트 지적(PR#4348 3라운드) 반영: 이전 버전은 ci.yml의
# destructive-shard 루프를 이 파일 안에 손으로 베껴 검증했다 — "ci.yml만 옛(버그 있는)
# 구조로 되돌려도 그 사본 테스트는 여전히 ALL PASS"라는 못 틀리는 대조였다. 이제 ci.yml과
# 이 테스트 둘 다 scripts/run-destructive-shard-loop.sh를 그대로 부른다 — 그 파일 자체를
# 뮤테이션하면(예: if/then/else/fi를 다시 `wrapper; code=$?`로 되돌리면) 이 테스트가
# 실측으로 빨개진다.
#
# 실 Postgres 없이 돌리기 위해 dropdb/createdb를 fake stub(no-op)으로 PATH에 얹는다
# (cleanup-ci-artifacts.test.sh의 fake `gh` stub과 동형 패턴). pytest 자리도 합성 파일
# 2개(첫째 exit 1·둘째 정상)로 대체 — HIGH(bash -e 생존) 회귀를 실측한다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOOP_SCRIPT="$SCRIPT_DIR/run-destructive-shard-loop.sh"
WRAPPER_SCRIPT="$SCRIPT_DIR/run-with-stall-detection.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAKE_BIN="$WORK/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/dropdb" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$FAKE_BIN/createdb" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKE_BIN/dropdb" "$FAKE_BIN/createdb"

cat > "$WORK/fake-pytest.sh" <<'EOF'
#!/usr/bin/env bash
[ "$1" = "fail.py" ] && exit 1
exit 0
EOF
chmod +x "$WORK/fake-pytest.sh"

FILES_LIST="$WORK/files.txt"
printf 'fail.py\npass.py\n' > "$FILES_LIST"

ELAPSED_OUT="$WORK/elapsed.tsv"
FAILED_OUT="$WORK/failed.txt"
: > "$ELAPSED_OUT"

echo "── run-destructive-shard-loop.sh(실 프로덕션 스크립트) — 합성 2파일: 첫째 exit 1·둘째 정상 ──"
set +e
OUT="$(PATH="$FAKE_BIN:$PATH" \
  WRAPPER_SCRIPT="$WRAPPER_SCRIPT" \
  STALL_TIMEOUT_MIN=8 \
  FILES_LIST_FILE="$FILES_LIST" \
  ELAPSED_OUT_FILE="$ELAPSED_OUT" \
  FAILED_OUT_FILE="$FAILED_OUT" \
  "$LOOP_SCRIPT" "$WORK/fake-pytest.sh" 2>&1)"
LOOP_CODE=$?
set -e

FAIL=0
if [ "$LOOP_CODE" -eq 0 ]; then
  echo "  ok   루프 스크립트 자체는 파일 실패와 무관하게 exit 0(판정은 호출부가 FAILED_OUT_FILE로 함, #2293 철학)"
else
  echo "  FAIL 루프 스크립트가 비정상 종료(exit ${LOOP_CODE}) — 출력: $OUT"
  FAIL=1
fi

if [[ "$OUT" == *"isolated fail.py"* ]] && [[ "$OUT" == *"isolated pass.py"* ]]; then
  echo "  ok   fail.py(exit 1) 뒤에도 -e가 안 죽이고 pass.py까지 루프 진행(HIGH 회귀 없음)"
else
  echo "  FAIL 루프가 두번째 파일까지 도달 못함 — 출력: $OUT"
  FAIL=1
fi

MAPPED_FAILED="$(cat "$FAILED_OUT" 2>/dev/null || true)"
if [ "$MAPPED_FAILED" = "fail.py" ]; then
  echo "  ok   FAILED_OUT_FILE에 fail.py 정확히 1건만 기록(pass.py는 안 들어감)"
else
  echo "  FAIL FAILED_OUT_FILE 내용=[${MAPPED_FAILED}](기대: fail.py 1건)"
  FAIL=1
fi

ELAPSED_LINES="$(wc -l < "$ELAPSED_OUT" | tr -d ' ')"
if [ "$ELAPSED_LINES" -eq 2 ]; then
  echo "  ok   elapsed 기록 2건(두 파일 모두 실제로 실행됨)"
else
  echo "  FAIL elapsed 기록 ${ELAPSED_LINES}건(기대 2)"
  FAIL=1
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "FAILURES ABOVE"
  exit 1
fi
