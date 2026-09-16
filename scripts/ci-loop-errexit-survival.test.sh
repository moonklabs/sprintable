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
echo "── dropdb/createdb 인프라 실패는 즉시 fail-fast(exit 1, 파일별 실패로 안 흡수) ──"
# 페드루 PO CHANGES(PR#4348 4라운드) — createdb가 실패하면(고아 커넥션 등) 조용히
# 지나가 다음 pytest가 없는/절반짜리 DB에서 돌다 그 파일 자체의 회귀로 오진된다.
FAKE_BIN_INFRA="$WORK/bin-infra-fail"
mkdir -p "$FAKE_BIN_INFRA"
cp "$FAKE_BIN/dropdb" "$FAKE_BIN_INFRA/dropdb"
cat > "$FAKE_BIN_INFRA/createdb" <<'EOF'
#!/usr/bin/env bash
echo "synthetic createdb failure" >&2
exit 1
EOF
chmod +x "$FAKE_BIN_INFRA/createdb"

INFRA_FAILED_OUT="$WORK/infra-failed.txt"
INFRA_ELAPSED_OUT="$WORK/infra-elapsed.tsv"
: > "$INFRA_ELAPSED_OUT"
set +e
INFRA_OUT="$(PATH="$FAKE_BIN_INFRA:$PATH" \
  WRAPPER_SCRIPT="$WRAPPER_SCRIPT" \
  STALL_TIMEOUT_MIN=8 \
  FILES_LIST_FILE="$FILES_LIST" \
  ELAPSED_OUT_FILE="$INFRA_ELAPSED_OUT" \
  FAILED_OUT_FILE="$INFRA_FAILED_OUT" \
  "$LOOP_SCRIPT" "$WORK/fake-pytest.sh" 2>&1)"
INFRA_CODE=$?
set -e

if [ "$INFRA_CODE" -eq 1 ]; then
  echo "  ok   createdb 실패 시 루프 스크립트가 즉시 exit 1(인프라 실패를 일반 pytest 실패와 구분)"
else
  echo "  FAIL createdb 실패인데 exit code=${INFRA_CODE}(기대 1) — 출력: $INFRA_OUT"
  FAIL=1
fi
if [[ "$INFRA_OUT" == *"::error::"* ]] && [[ "$INFRA_OUT" == *"createdb"* ]]; then
  echo "  ok   ::error:: 메시지가 createdb 재생성 실패를 명시함"
else
  echo "  FAIL createdb 실패 ::error:: 메시지 누락 — 출력: $INFRA_OUT"
  FAIL=1
fi
if [ ! -s "$INFRA_FAILED_OUT" ]; then
  echo "  ok   FAILED_OUT_FILE에 안 섞임(인프라 실패는 «파일 실패» 목록이 아니다)"
else
  echo "  FAIL 인프라 실패가 FAILED_OUT_FILE에 섞여 들어감 — 내용: $(cat "$INFRA_FAILED_OUT")"
  FAIL=1
fi

echo
echo "── dropdb 인프라 실패도 대칭으로 즉시 fail-fast(PO 5라운드 — createdb만 자가진단 있었음) ──"
FAKE_BIN_INFRA_DROP="$WORK/bin-infra-fail-dropdb"
mkdir -p "$FAKE_BIN_INFRA_DROP"
cat > "$FAKE_BIN_INFRA_DROP/dropdb" <<'EOF'
#!/usr/bin/env bash
echo "synthetic dropdb failure" >&2
exit 1
EOF
chmod +x "$FAKE_BIN_INFRA_DROP/dropdb"
cp "$FAKE_BIN/createdb" "$FAKE_BIN_INFRA_DROP/createdb"

INFRA_DROP_FAILED_OUT="$WORK/infra-drop-failed.txt"
INFRA_DROP_ELAPSED_OUT="$WORK/infra-drop-elapsed.tsv"
: > "$INFRA_DROP_ELAPSED_OUT"
set +e
INFRA_DROP_OUT="$(PATH="$FAKE_BIN_INFRA_DROP:$PATH" \
  WRAPPER_SCRIPT="$WRAPPER_SCRIPT" \
  STALL_TIMEOUT_MIN=8 \
  FILES_LIST_FILE="$FILES_LIST" \
  ELAPSED_OUT_FILE="$INFRA_DROP_ELAPSED_OUT" \
  FAILED_OUT_FILE="$INFRA_DROP_FAILED_OUT" \
  "$LOOP_SCRIPT" "$WORK/fake-pytest.sh" 2>&1)"
INFRA_DROP_CODE=$?
set -e

if [ "$INFRA_DROP_CODE" -eq 1 ]; then
  echo "  ok   dropdb 실패 시 루프 스크립트가 즉시 exit 1"
else
  echo "  FAIL dropdb 실패인데 exit code=${INFRA_DROP_CODE}(기대 1) — 출력: $INFRA_DROP_OUT"
  FAIL=1
fi
if [[ "$INFRA_DROP_OUT" == *"::error::"* ]] && [[ "$INFRA_DROP_OUT" == *"dropdb"* ]]; then
  echo "  ok   ::error:: 메시지가 dropdb 재생성 실패를 명시함"
else
  echo "  FAIL dropdb 실패 ::error:: 메시지 누락 — 출력: $INFRA_DROP_OUT"
  FAIL=1
fi
if [ ! -s "$INFRA_DROP_FAILED_OUT" ]; then
  echo "  ok   FAILED_OUT_FILE에 안 섞임(dropdb 실패도 «파일 실패» 목록이 아니다)"
else
  echo "  FAIL dropdb 인프라 실패가 FAILED_OUT_FILE에 섞여 들어감 — 내용: $(cat "$INFRA_DROP_FAILED_OUT")"
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
