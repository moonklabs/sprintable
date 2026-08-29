"""story #3199 — macOS 호스트 SysV shm(kern.sysv.shmmni=32 기본값) saturation으로 disposable
PG 반복 기동이 막히던 문제(미르코·저자 세션 동형 재현, ipcs -m 32/32). 정리 루틴
scripts/disposable_pg.sh의 스윕 로직 pin — 실 SysV IPC/실 PG는 건드리지 않는다(macOS
전용·호스트 상태 의존이라 CI 러너에서 그대로 못 돌림). ipcs/ipcrm/pg_ctl/postgres/ps를
전부 가짜 실행파일로 스텁한다.

카디르 QA(PR#3616 head cd21e1794) HIGH 2건 반영 후의 pin:
  ① 세션 모드 signal 프롬프트니스 — foreground `sleep 3600`이 SIGTERM을 1시간 잡아두던
    결함을 백그라운드 sleep+wait+명시 exit 트랩으로 고쳤다. 실 하위프로세스로 스크립트를
    띄우고 SIGTERM을 보내 초 단위로 종료됨을 시간으로 잰다.
  ② lazy-sweep — 스윕은 이제 "평시"엔 절대 안 돌고, pg_ctl start/initdb가 shm 관련
    사유로 실패했을 때만(로그 시그니처) 돈다. pg_ctl 스텁을 "1차 실패(shmget 로그)+2차
    성공"으로 만들어 이 재시도 경로를 정확히 태운다 — 정상 기동(1차 성공)일 땐 ipcrm이
    한 번도 안 불림을 별도로 pin.

판별(story 본문): 저자 세션에서 disposable PG 1회 기동+realdb 1건 실행 재현 — 이건 이
스크립트로 실물 재현 완료(수동 검증, 이 pytest는 로직 회귀가드).
"""
from __future__ import annotations

import os
import stat
import subprocess
import time
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "disposable_pg.sh"


def _make_stub(path: Path, body: str) -> None:
    path.write_text(f"#!/usr/bin/env bash\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


def _pg_ctl_stub_body(fail_marker: Path, extra_shm_error: bool) -> str:
    """pg_ctl 스텁 — start는 fail_marker 파일이 없으면 1회 "shmget 실패"로 로그를 남기고
    실패, 있으면(=재시도) 성공. stop은 항상 성공(no-op)."""
    shm_line = (
        'echo "FATAL:  could not create shared memory segment: shmget(...) failed: '
        'No space left on device" >> "$logfile"' if extra_shm_error else 'true'
    )
    return f"""
args=("$@")
is_stop=0
for a in "${{args[@]}}"; do [ "$a" = "stop" ] && is_stop=1; done
if [ "$is_stop" = 1 ]; then
  exit 0
fi
logfile=""
prev=""
for a in "${{args[@]}}"; do
  if [ "$prev" = "-l" ]; then logfile="$a"; fi
  prev="$a"
done
if [ ! -f "{fail_marker}" ]; then
  touch "{fail_marker}"
  {shm_line}
  exit 1
fi
echo "server started"
exit 0
"""


@pytest.fixture
def fake_env(tmp_path, request):
    """ipcs -m이 live(1001, 자기 data-dir)+병행 세션 live(4004, 다른 data-dir)+
    orphan(2002,3003) 4개 세그를 보고하는 가짜 호스트. pg_ctl start는 기본적으로 1차
    "shmget 실패" 후 2차 성공(재시도 경로가 항상 태워짐) — `always_succeed` 마커로 1차부터
    바로 성공하는 변형도 만든다(평시=스윕 0회 확인용)."""
    always_succeed = getattr(request, "param", False)

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "ipcrm_calls.log"
    fail_marker = tmp_path / "pg_ctl_attempted"

    _make_stub(bin_dir / "ipcs", """
if [ "$1" = "-m" ]; then
  echo "IPC status from <fake> as of now"
  echo "T     ID     KEY        MODE       OWNER    GROUP"
  echo "Shared Memory:"
  echo "m 1001 0x00000000 --rw------- fakeuser  fakeuser"
  echo "m 4004 0x33333333 --rw------- fakeuser  fakeuser"
  echo "m 2002 0x11111111 --rw------- fakeuser  fakeuser"
  echo "m 3003 0x22222222 --rw------- fakeuser  fakeuser"
fi
""")
    _make_stub(bin_dir / "ipcrm", f"""
echo "$@" >> {log}
exit 0
""")
    if always_succeed:
        _make_stub(bin_dir / "pg_ctl", """
args=("$@")
for a in "${args[@]}"; do [ "$a" = "stop" ] && exit 0; done
echo "server started"
exit 0
""")
    else:
        _make_stub(bin_dir / "pg_ctl", _pg_ctl_stub_body(fail_marker, extra_shm_error=True))
    _make_stub(bin_dir / "postgres", "exit 0")
    _make_stub(bin_dir / "initdb", "exit 0")

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "postmaster.pid").write_text(
        "12345\n/fake/data\n1700000000\n55999\n/tmp\nlocalhost\n 999999     1001\nready\n"
    )

    other_data_dir = tmp_path / "other-session-data"
    other_data_dir.mkdir()
    (other_data_dir / "postmaster.pid").write_text(
        "22222\n/fake/other\n1700000001\n55440\n/tmp\nlocalhost\n 888888     4004\nready\n"
    )

    ps_calls = tmp_path / "ps_calls.log"
    _make_stub(bin_dir / "ps", f"""
if [ "$1" = "-axwwo" ]; then
  echo x >> {ps_calls}
  echo "/usr/local/bin/postgres -D {data_dir}"
  echo "/usr/local/bin/postgres -D {other_data_dir}"
fi
""")

    env = dict(os.environ)
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    return {
        "env": env, "data_dir": data_dir, "other_data_dir": other_data_dir,
        "log": log, "ps_calls": ps_calls, "tmp_path": tmp_path,
    }


def test_sweep_excludes_live_and_concurrent_session_removes_only_orphans(fake_env):
    """재시도(1차 shmget 실패→스윕→2차 성공) 경로에서 live(1001)와 병행 세션 live(4004,
    PR#3616 카디르 QA 지적 축)는 빠지고 orphan(2002·3003)만 지워진다."""
    result = subprocess.run(
        ["bash", str(SCRIPT), str(fake_env["data_dir"]), "55999", "--", "true"],
        env=fake_env["env"], capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr

    removed_ids = fake_env["log"].read_text().split()
    assert "4004" not in removed_ids
    assert "1001" not in removed_ids
    assert "2002" in removed_ids
    assert "3003" in removed_ids


def test_ipcrm_failure_reports_real_exit_code_not_zero(fake_env):
    """페드루 코스메틱 지적(PR#3616 재QA) — `if ! err=$(...); then rc=$?`는 `!`가 이미
    부정한 뒤라 그 안의 $?가 항상 0을 찍던 버그. ipcrm이 EPERM 아닌 사유(예: 42)로
    실패하면 stderr의 «rc=»가 실제 종료코드를 찍어야 한다(0 아님)."""
    _make_stub(fake_env["tmp_path"] / "bin" / "ipcrm", """
echo "device or resource busy (fake non-EPERM failure)" >&2
exit 42
""")
    result = subprocess.run(
        ["bash", str(SCRIPT), str(fake_env["data_dir"]), "55999", "--", "true"],
        env=fake_env["env"], capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert "rc=42" in result.stderr, result.stderr
    assert "rc=0" not in result.stderr


@pytest.mark.parametrize("fake_env", [True], indirect=True)
def test_lazy_sweep_never_runs_when_start_succeeds_on_first_try(fake_env):
    """카디르 QA HIGH② — 평시(첫 시도 성공)엔 스윕이 아예 안 돈다. 무고한 세그를 건드리는
    창이 «포화로 실제 실패했을 때»로만 좁혀졌음을 고정."""
    result = subprocess.run(
        ["bash", str(SCRIPT), str(fake_env["data_dir"]), "55999", "--", "true"],
        env=fake_env["env"], capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert not fake_env["log"].exists() or fake_env["log"].read_text().strip() == ""


def test_start_failure_unrelated_to_shm_does_not_trigger_sweep(fake_env):
    """shm 시그니처가 없는 실패(예: 권한 문제)는 스윕을 트리거하지 않고 그대로 에러
    전파한다 — shm 무관 실패까지 스윕으로 덮어 진짜 원인을 가리지 않는다."""
    non_shm_fail = _pg_ctl_stub_body(fake_env["tmp_path"] / "never-touched", extra_shm_error=False)
    _make_stub(fake_env["tmp_path"] / "bin" / "pg_ctl", non_shm_fail.replace(
        "No space left on device", "").replace(
        'echo "FATAL:  could not create shared memory segment: shmget(...) failed: " >> "$logfile"',
        'echo "FATAL:  data directory has invalid permissions" >> "$logfile"',
    ))
    result = subprocess.run(
        ["bash", str(SCRIPT), str(fake_env["data_dir"]), "55999", "--", "true"],
        env=fake_env["env"], capture_output=True, text=True, timeout=10,
    )
    assert result.returncode != 0
    assert not fake_env["log"].exists() or fake_env["log"].read_text().strip() == ""


def test_one_shot_mode_runs_command_and_propagates_exit_code(fake_env):
    """`-- <command>` 원샷 모드 — 명령의 종료코드를 그대로 반환한다."""
    result = subprocess.run(
        ["bash", str(SCRIPT), str(fake_env["data_dir"]), "55999", "--", "bash", "-c", "exit 7"],
        env=fake_env["env"], capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 7


def test_missing_args_usage_error():
    result = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 2
    assert "usage" in result.stderr


@pytest.mark.parametrize("fake_env", [True], indirect=True)
def test_session_mode_terminates_promptly_on_sigterm_not_after_full_sleep(fake_env):
    """카디르 QA HIGH① — 세션 모드(원샷 아님)에서 SIGTERM을 보내면 foreground
    `sleep 3600` 전체를 기다리지 않고 수 초 내로 종료돼야 한다(백그라운드 sleep+wait는
    트랩된 시그널에 즉시 인터럽트됨). 이 스크립트 자신이 막으려는 "종료 trap 지연"
    결함을 재생산하지 않는지가 핵심."""
    proc = subprocess.Popen(
        ["bash", str(SCRIPT), str(fake_env["data_dir"]), "55999"],
        env=fake_env["env"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        # "disposable PG ready" 라인이 뜰 때까지(세션 모드 진입 확認) 짧게 폴링.
        deadline = time.monotonic() + 5
        ready = False
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if "ready" in line:
                ready = True
                break
        assert ready, "session mode did not report ready in time"

        start = time.monotonic()
        proc.terminate()  # SIGTERM
        proc.wait(timeout=5)
        elapsed = time.monotonic() - start
        assert elapsed < 5, f"SIGTERM took {elapsed:.2f}s — sleep 3600이 여전히 signal을 막는 중"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
