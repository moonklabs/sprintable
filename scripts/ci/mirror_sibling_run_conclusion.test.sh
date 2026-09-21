#!/usr/bin/env bash
# story #4099 AC2 — mirror_sibling_run_conclusion.sh 실측 스모크테스트. 진짜 GitHub API를
# 건드리지 않고 가짜 `gh` 스텁이 합성 run/jobs 목록을 돌려준다(cleanup-ci-artifacts.test.sh
# 동형 원칙 — 실물 대신 통제된 합성 데이터로 4갈래 판정을 실행 결과로 고정한다).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/mirror_sibling_run_conclusion.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
assert_exit_code() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ok   $label (exit=$actual)"
  else
    echo "  FAIL $label — expected exit $expected, got $actual"
    FAIL=1
  fi
}

# 공통 — 「이 run 자신」은 항상 id=555. GH_REPO는 fake gh가 안 보므로 아무 값이나 무방.
export GH_REPO="moonklabs/sprintable"

make_fake_gh() {
  local bin_dir="$1" runs_fixture="$2" jobs_script="$3"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/gh" <<GHSTUB
#!/usr/bin/env bash
if [ "\$1" != "api" ]; then
  echo "unexpected gh invocation: \$*" >&2
  exit 1
fi
URL="\$2"
JQ_EXPR=""
shift 2
while [ \$# -gt 0 ]; do
  case "\$1" in
    --jq) JQ_EXPR="\$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "\$URL" in
  */actions/runs\?head_sha=*)
    jq "\$JQ_EXPR" "$runs_fixture"
    ;;
  */actions/runs/*/jobs\?*)
    bash "$jobs_script" "\$URL" "\$JQ_EXPR"
    ;;
  *)
    echo "unexpected gh api url: \$URL" >&2
    exit 1
    ;;
esac
GHSTUB
  chmod +x "$bin_dir/gh"
}

run_script() {
  local bin_dir="$1"; shift
  PATH="$bin_dir:$PATH" "$SCRIPT" "$@"
}

echo "── 시나리오 1: 원본 잡 success(첫 폴링에 즉시 완주) → exit 0 ──"
RUNS1="$WORK/runs1.json"
cat > "$RUNS1" <<'JSON'
{"workflow_runs": [
  {"id": 555, "name": "CI"},
  {"id": 300, "name": "CI"}
]}
JSON
JOBS1="$WORK/jobs1.sh"
cat > "$JOBS1" <<'BASH'
jq "$2" <<'JSON'
{"jobs": [{"name": "Backend pytest", "status": "completed", "conclusion": "success"}]}
JSON
BASH
BIN1="$WORK/bin1"
make_fake_gh "$BIN1" "$RUNS1" "$JOBS1"
set +e
OUT1="$(run_script "$BIN1" --job-name "Backend pytest" --head-sha abc123 --this-run-id 555 --poll-interval-seconds 1 --max-wait-seconds 5 2>&1)"
RC1=$?
set -e
echo "$OUT1" | sed 's/^/    /'
assert_exit_code "$RC1" "0" "success 미러 → exit 0"

echo "── 시나리오 2: 원본 잡 failure → exit 1 ──"
JOBS2="$WORK/jobs2.sh"
cat > "$JOBS2" <<'BASH'
jq "$2" <<'JSON'
{"jobs": [{"name": "Backend pytest", "status": "completed", "conclusion": "failure"}]}
JSON
BASH
BIN2="$WORK/bin2"
make_fake_gh "$BIN2" "$RUNS1" "$JOBS2"
set +e
OUT2="$(run_script "$BIN2" --job-name "Backend pytest" --head-sha abc123 --this-run-id 555 --poll-interval-seconds 1 --max-wait-seconds 5 2>&1)"
RC2=$?
set -e
echo "$OUT2" | sed 's/^/    /'
assert_exit_code "$RC2" "1" "failure 미러 → exit 1"

echo "── 시나리오 2b: 원본 잡 cancelled → exit 1 ──"
JOBS2B="$WORK/jobs2b.sh"
cat > "$JOBS2B" <<'BASH'
jq "$2" <<'JSON'
{"jobs": [{"name": "Backend pytest", "status": "completed", "conclusion": "cancelled"}]}
JSON
BASH
BIN2B="$WORK/bin2b"
make_fake_gh "$BIN2B" "$RUNS1" "$JOBS2B"
set +e
OUT2B="$(run_script "$BIN2B" --job-name "Backend pytest" --head-sha abc123 --this-run-id 555 --poll-interval-seconds 1 --max-wait-seconds 5 2>&1)"
RC2B=$?
set -e
assert_exit_code "$RC2B" "1" "cancelled 미러 → exit 1"

echo "── 시나리오 3: 같은 head_sha의 진짜 run이 없음(이 run 자신뿐) → exit 1(즉시, 폴링 없음) ──"
RUNS3="$WORK/runs3.json"
cat > "$RUNS3" <<'JSON'
{"workflow_runs": [
  {"id": 555, "name": "CI"}
]}
JSON
JOBS3="$WORK/jobs3.sh"
cat > "$JOBS3" <<'BASH'
echo "unexpected — sibling run lookup should have short-circuited before any jobs call" >&2
exit 1
BASH
BIN3="$WORK/bin3"
make_fake_gh "$BIN3" "$RUNS3" "$JOBS3"
set +e
OUT3="$(run_script "$BIN3" --job-name "Backend pytest" --head-sha abc123 --this-run-id 555 --poll-interval-seconds 1 --max-wait-seconds 5 2>&1)"
RC3=$?
set -e
echo "$OUT3" | sed 's/^/    /'
assert_exit_code "$RC3" "1" "진짜 run 없음 → exit 1(fail-closed)"

echo "── 시나리오 4: 원본 잡이 계속 in_progress(타임아웃) → exit 1 ──"
JOBS4="$WORK/jobs4.sh"
cat > "$JOBS4" <<'BASH'
jq "$2" <<'JSON'
{"jobs": [{"name": "Backend pytest", "status": "in_progress", "conclusion": null}]}
JSON
BASH
BIN4="$WORK/bin4"
make_fake_gh "$BIN4" "$RUNS1" "$JOBS4"
set +e
OUT4="$(run_script "$BIN4" --job-name "Backend pytest" --head-sha abc123 --this-run-id 555 --poll-interval-seconds 1 --max-wait-seconds 2 2>&1)"
RC4=$?
set -e
echo "$OUT4" | sed 's/^/    /'
assert_exit_code "$RC4" "1" "계속 in_progress·max-wait 초과 → exit 1(타임아웃, fail-closed)"

echo "── 시나리오 5(폴링 실증) — 처음엔 in_progress, 두 번째 폴링에서 completed/success로 바뀜 → 폴링을 실제로 기다린 뒤 exit 0 ──"
CALL_COUNT="$WORK/call-count-5"
echo 0 > "$CALL_COUNT"
JOBS5="$WORK/jobs5.sh"
cat > "$JOBS5" <<BASH
COUNT_FILE="$CALL_COUNT"
N=\$(cat "\$COUNT_FILE")
N=\$((N + 1))
echo "\$N" > "\$COUNT_FILE"
if [ "\$N" -lt 2 ]; then
  jq "\$2" <<'JSON'
{"jobs": [{"name": "Backend pytest", "status": "in_progress", "conclusion": null}]}
JSON
else
  jq "\$2" <<'JSON'
{"jobs": [{"name": "Backend pytest", "status": "completed", "conclusion": "success"}]}
JSON
fi
BASH
BIN5="$WORK/bin5"
make_fake_gh "$BIN5" "$RUNS1" "$JOBS5"
set +e
OUT5="$(run_script "$BIN5" --job-name "Backend pytest" --head-sha abc123 --this-run-id 555 --poll-interval-seconds 1 --max-wait-seconds 10 2>&1)"
RC5=$?
set -e
echo "$OUT5" | sed 's/^/    /'
assert_exit_code "$RC5" "0" "1차 in_progress → 2차 success로 폴링 뒤 exit 0"
CALLS5="$(cat "$CALL_COUNT")"
if [ "$CALLS5" -ge 2 ]; then
  echo "  ok   실제로 2회 이상 폴링했다(호출 ${CALLS5}회) — 즉시 skip이 아니라 진짜 대기"
else
  echo "  FAIL 폴링 호출 수가 예상보다 적음(${CALLS5}회)"
  FAIL=1
fi

echo "── 시나리오 6: 다른 잡 이름(이 잡 대상이 아닌)은 job 목록에 안 보여도(레이스) 결국 못 찾으면 타임아웃 처리 ──"
JOBS6="$WORK/jobs6.sh"
cat > "$JOBS6" <<'BASH'
jq "$2" <<'JSON'
{"jobs": [{"name": "Lint, Type Check, Test, Build", "status": "completed", "conclusion": "success"}]}
JSON
BASH
BIN6="$WORK/bin6"
make_fake_gh "$BIN6" "$RUNS1" "$JOBS6"
set +e
OUT6="$(run_script "$BIN6" --job-name "Backend pytest" --head-sha abc123 --this-run-id 555 --poll-interval-seconds 1 --max-wait-seconds 2 2>&1)"
RC6=$?
set -e
assert_exit_code "$RC6" "1" "대상 잡 이름이 목록에 없음(다른 이름만 있음) → 결국 타임아웃 exit 1"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "OK: mirror_sibling_run_conclusion.sh 전 시나리오 통과"
  exit 0
else
  echo "FAIL: 위 실패 항목 확인"
  exit 1
fi
