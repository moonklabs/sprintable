#!/usr/bin/env bash
# story #3944 AC2 — run-with-stall-detection.sh 양성대조 2건(cleanup-ci-artifacts.test.sh와
# 동형 원칙: 실물 대신 통제된 합성 커맨드로 "정지=실패/진행 中(완주)=통과"를 실행 결과로
# 고정한다). GNU coreutils timeout(1)이 필요 — macOS는 `brew install coreutils`(gtimeout)
# 후 PATH에 gnubin을 얹어야 한다(CI 러너 ubuntu-latest는 기본 내장, 별도 조치 불요).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/run-with-stall-detection.sh"

if ! command -v timeout >/dev/null 2>&1; then
  echo "SKIP: timeout(1)이 PATH에 없습니다(macOS면 'brew install coreutils' 후 gnubin을 PATH에 얹으세요)" >&2
  exit 0
fi

FAIL=0

echo "── 정지(합성 샤드가 제한 시간 안에 안 끝남) → STALL 실패 ──"
set +e
OUT="$("$SCRIPT" 0.02 -- sleep 5 2>&1)"
CODE=$?
set -e
if [ "$CODE" -eq 124 ]; then
  echo "  ok   exit code 124(coreutils timeout 관례값)"
else
  echo "  FAIL exit code=${CODE}(기대 124)"
  FAIL=1
fi
if [[ "$OUT" == *"STALL"* ]]; then
  echo "  ok   STALL 메시지 출력됨"
else
  echo "  FAIL STALL 메시지가 안 보임 — 출력: $OUT"
  FAIL=1
fi

echo
echo "── TERM 무시(고아 프로세스 방지) → KILL escalation도 결국 124로 정규화 ──"
# 페드루 PO CHANGES(PR#4348 잔여①) — 자식이 TERM을 씹으면(uv/pytest가 신호를 못
# 넘기는 경우의 재현) `-k`가 KILL까지 보내는지, 그리고 그 KILL 경로(coreutils
# 실측 exit 137)도 이 래퍼가 124로 정규화해 돌려주는지 실측한다. STALL_KILL_AFTER를
# 짧게 줘서 기본 30초를 기다리지 않는다(CI 실제 값은 여전히 30초 그대로). 제한시간을
# 0.05분(3초)으로(0.02분=1.2초보다 넉넉히) 잡아 `date +%s` 1초 해상도 경계오차를 피한다
# (경과시간 대조가 4라운드에 새로 들어갔으므로 — 아래 참고).
set +e
OUT="$(STALL_KILL_AFTER=2s "$SCRIPT" 0.05 -- bash -c 'trap "" TERM; sleep 60' 2>&1)"
CODE=$?
set -e
if [ "$CODE" -eq 124 ]; then
  echo "  ok   TERM 무시해도 KILL 뒤 exit 124로 정규화됨(137 그대로 새지 않음)"
else
  echo "  FAIL exit code=${CODE}(기대 124) — TERM 무시 시 KILL escalation이 137로 샐 수 있음"
  FAIL=1
fi
if [[ "$OUT" == *"STALL"* ]] && [[ "$OUT" == *"KILL"* ]]; then
  echo "  ok   STALL 메시지가 KILL escalation 여부를 명시함"
else
  echo "  FAIL STALL/KILL 메시지 누락 — 출력: $OUT"
  FAIL=1
fi

echo
echo "── 즉발 외부 SIGKILL(137)은 제한시간 도달 前이면 STALL로 안 새고 원 코드 그대로 ──"
# 페드루 PO CHANGES(PR#4348 4라운드, 카디르 재현) — 137은 우리 KILL escalation
# 말고도 외부(OOM killer 등, 우리 제한시간과 무관)에서도 나올 수 있다. 넉넉한
# 제한시간(60초) 안에서 명령이 스스로 즉시 자기 자신에게 SIGKILL을 보내면(실측 경과
# ≪ 60초) STALL로 오분류되면 안 되고, 137을 있는 그대로 돌려줘야 한다.
set +e
OUT="$("$SCRIPT" 1 -- bash -c 'kill -9 $$' 2>&1)"
CODE=$?
set -e
if [ "$CODE" -eq 137 ]; then
  echo "  ok   즉발 SIGKILL은 137 그대로 전달(제한시간 60초 도달 前이므로 STALL 아님)"
else
  echo "  FAIL exit code=${CODE}(기대 137, 즉발 SIGKILL 원코드 보존)"
  FAIL=1
fi
if [[ "$OUT" != *"STALL"* ]]; then
  echo "  ok   STALL 메시지 없음(우리 정지 감지가 한 일이 아니므로)"
else
  echo "  FAIL 즉발 SIGKILL인데 STALL로 오분류됨 — 출력: $OUT"
  FAIL=1
fi

echo
echo "── 경계 결정론 자가진단(PO 6라운드) — 반올림이 판정에 안 새는지 실제 타이밍 없이 고정 ──"
# 페드루 PO CHANGES(PR#4348 6라운드, 카디르 0.4ms 경계 재현) — 이전 버전은 elapsed를
# `%.3f`로 반올림한 문자열을 판정 비교에도 그대로 썼다 — raw 0.5996s(제한 0.6s 直前)가
# 0.600으로 반올림되면 "제한 도달"로 잘못 넘어간다. 실제 wall-clock으로 이 경계를
# 맞히려면 수백 μs~ms 폭의 타이밍 레이스가 필요해 자가진단으로 못 쓴다 —
# STALL_TEST_ELAPSED_OVERRIDE로 그 경계 값 자체를 주입해 결정론으로 고정한다.
# 제한시간 0.01분=정확히 0.6초(TIMEOUT_MIN*60, 반올림 없이 정확).
set +e
UNDER_OUT="$(STALL_TEST_ELAPSED_OVERRIDE=0.5996 "$SCRIPT" 0.01 -- bash -c 'kill -9 $$' 2>&1)"
UNDER_CODE=$?
set -e
if [ "$UNDER_CODE" -eq 137 ]; then
  echo "  ok   raw elapsed 0.5996s(제한 0.6s 直前) → 137 그대로(반올림했다면 0.600으로 붙어 STALL 오분류)"
else
  echo "  FAIL 경계 直前인데 exit code=${UNDER_CODE}(기대 137) — 출력: $UNDER_OUT"
  FAIL=1
fi

set +e
OVER_OUT="$(STALL_TEST_ELAPSED_OVERRIDE=0.6004 "$SCRIPT" 0.01 -- bash -c 'kill -9 $$' 2>&1)"
OVER_CODE=$?
set -e
if [ "$OVER_CODE" -eq 124 ]; then
  echo "  ok   raw elapsed 0.6004s(제한 0.6s 직후) → 124(STALL)로 정확히 정규화"
else
  echo "  FAIL 경계 직후인데 exit code=${OVER_CODE}(기대 124) — 출력: $OVER_OUT"
  FAIL=1
fi

echo
echo "── 진행 中(제한 시간 안에 정상 완주) → 통과(원 종료 코드 그대로) ──"
set +e
OUT="$("$SCRIPT" 0.5 -- sleep 0.1 2>&1)"
CODE=$?
set -e
if [ "$CODE" -eq 0 ]; then
  echo "  ok   정상 완주 시 exit code 0 그대로 통과"
else
  echo "  FAIL exit code=${CODE}(기대 0)"
  FAIL=1
fi
if [[ "$OUT" != *"STALL"* ]]; then
  echo "  ok   STALL 메시지 없음(정지 아니었으므로)"
else
  echo "  FAIL 정상 완주인데 STALL 메시지가 나왔다 — 출력: $OUT"
  FAIL=1
fi

echo
echo "── 명령 자체의 정상 실패(정지 아님)는 원 종료 코드를 그대로 전달 ──"
set +e
OUT="$("$SCRIPT" 0.5 -- bash -c 'exit 3' 2>&1)"
CODE=$?
set -e
if [ "$CODE" -eq 3 ]; then
  echo "  ok   원 종료 코드(3) 그대로 전달 — 정지 판정과 일반 실패를 혼동하지 않는다"
else
  echo "  FAIL exit code=${CODE}(기대 3)"
  FAIL=1
fi
if [[ "$OUT" != *"STALL"* ]]; then
  echo "  ok   STALL 메시지 없음(정상 종료였으므로)"
else
  echo "  FAIL 일반 실패인데 STALL 메시지가 나왔다 — 출력: $OUT"
  FAIL=1
fi

echo
echo "── story #4319 — 증거 수집(STALL_EVIDENCE_DIR): 죽이기 전에 DB · 스택 증거, 정상 판엔 아무 일도 안 함 ──"
EV_TMP="$(mktemp -d)"
mkdir -p "$EV_TMP/bin" "$EV_TMP/evidence"
# 가짜 psql — 실 DB 없이 «수집기가 DB 조회를 부른다»만 확인(인자 기록).
cat > "$EV_TMP/bin/psql" <<'STUB'
#!/usr/bin/env bash
echo "FAKE_PSQL $*" >> "${FAKE_PSQL_LOG:?}"
echo "fake psql row"
STUB
chmod +x "$EV_TMP/bin/psql"
# 가짜 pytest — 명령줄에 pytest가 있는 python 프로세스(실 CI의 `.venv/bin/python …/pytest`와 같은 모양). conftest처럼
# SIGUSR1 · SIGUSR2를 받으면 증거 폴더에 덤프 파일을 쓴다.
cat > "$EV_TMP/fake_pytest.py" <<'PY'
import os, signal, sys, time
d = os.environ["STALL_EVIDENCE_DIR"]
def dump(kind):
    def h(_s, _f):
        with open(os.path.join(d, f"pytest-{os.getpid()}-{kind}.txt"), "a") as out:
            out.write(f"FAKE {kind} dump\n")
    return h
signal.signal(signal.SIGUSR1, dump("threads"))
signal.signal(signal.SIGUSR2, dump("asyncio"))
time.sleep(float(sys.argv[1]))
PY
PYTHON_BIN="$(command -v python3)"

set +e
OUT="$(PATH="$EV_TMP/bin:$PATH" FAKE_PSQL_LOG="$EV_TMP/psql.log" STALL_EVIDENCE_DIR="$EV_TMP/evidence" \
  STALL_EVIDENCE_LEAD_SEC=2 STALL_EVIDENCE_DUMP_WAIT_SEC=1 STALL_KILL_AFTER=1s \
  "$SCRIPT" 0.1 -- "$PYTHON_BIN" "$EV_TMP/fake_pytest.py" 60 pytest-marker 2>&1)"
CODE=$?
set -e
if [ "$CODE" -eq 124 ]; then echo "  ok   정지 판정 그대로(124)"; else echo "  FAIL exit code=${CODE}(기대 124) — 출력: $OUT"; FAIL=1; fi
if [[ "$OUT" == *"STALL evidence(story #4319)"* ]] && [[ "$OUT" == *"fake psql row"* ]]; then
  echo "  ok   죽이기 전에 증거 묶음 · DB 조회"
else
  echo "  FAIL 증거 묶음 · DB 조회가 안 보임 — 출력: $OUT"; FAIL=1
fi
if [[ "$OUT" == *"FAKE threads dump"* ]] && [[ "$OUT" == *"FAKE asyncio dump"* ]]; then
  echo "  ok   pytest 프로세스에 SIGUSR1 · SIGUSR2 → 두 덤프가 로그에"
else
  echo "  FAIL 스택 덤프가 로그에 없음 — 출력: $OUT"; FAIL=1
fi
_ev_line=$(printf '%s\n' "$OUT" | grep -n "STALL evidence" | head -1 | cut -d: -f1)
_stall_line=$(printf '%s\n' "$OUT" | grep -n "^STALL:" | head -1 | cut -d: -f1)
if [ -n "$_ev_line" ] && [ -n "$_stall_line" ] && [ "$_ev_line" -lt "$_stall_line" ]; then
  echo "  ok   증거가 STALL 판정(강제 종료)보다 먼저"
else
  echo "  FAIL 증거가 STALL 뒤이거나 없음(ev=${_ev_line:-없음} stall=${_stall_line:-없음})"; FAIL=1
fi

rm -f "$EV_TMP/psql.log"
set +e
_t0=$(date +%s)
OUT="$(PATH="$EV_TMP/bin:$PATH" FAKE_PSQL_LOG="$EV_TMP/psql.log" STALL_EVIDENCE_DIR="$EV_TMP/evidence" \
  STALL_EVIDENCE_LEAD_SEC=2 "$SCRIPT" 0.5 -- bash -c 'exit 3' 2>&1)"
CODE=$?
_took=$(( $(date +%s) - _t0 ))
OUT_OK="$(PATH="$EV_TMP/bin:$PATH" FAKE_PSQL_LOG="$EV_TMP/psql.log" STALL_EVIDENCE_DIR="$EV_TMP/evidence" \
  STALL_EVIDENCE_LEAD_SEC=2 "$SCRIPT" 0.5 -- true 2>&1)"
CODE_OK=$?
set -e
if [ "$CODE" -eq 3 ] && [ "$CODE_OK" -eq 0 ]; then echo "  ok   정상 판 종료 코드 그대로(3 · 0)"; else echo "  FAIL exit code=${CODE}/${CODE_OK}(기대 3/0)"; FAIL=1; fi
if [ ! -e "$EV_TMP/psql.log" ] && [[ "$OUT$OUT_OK" != *"STALL evidence"* ]]; then
  echo "  ok   정상 판엔 수집 0(DB 조회 · 증거 묶음 없음)"
else
  echo "  FAIL 정상 판인데 수집이 돌았다 — 출력: $OUT $OUT_OK"; FAIL=1
fi
if [ "$_took" -le 2 ]; then
  echo "  ok   정상 판에 기다림이 안 붙는다(${_took}s · 수집기 sleep은 거둔다 · AC7)"
else
  echo "  FAIL 정상 판이 ${_took}s 걸림 — 수집기를 기다린다"; FAIL=1
fi
rm -rf "$EV_TMP"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "ALL PASS"
  exit 0
else
  echo "FAILURES ABOVE"
  exit 1
fi
