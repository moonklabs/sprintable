"""story #3199 — macOS 호스트 SysV shm(kern.sysv.shmmni=32 기본값) saturation으로 disposable
PG 반복 기동이 막히던 문제(미르코·저자 세션 동형 재현, ipcs -m 32/32). 정리 루틴
scripts/disposable_pg.sh의 스윕 로직 pin — 실 SysV IPC/실 PG는 건드리지 않는다(macOS
전용·호스트 상태 의존이라 CI 러너에서 그대로 못 돌림). ipcs/ipcrm/pg_ctl/postgres를 전부
가짜 실행파일로 스텁해 "살아있는 클러스터(postmaster.pid 7번째 줄 실물 대조)만 제외하고
나머지 shm만 ipcrm된다"는 로직 자체를 고정한다.

판별(story 본문): 저자 세션에서 disposable PG 1회 기동+realdb 1건 실행 재현 —
이건 이 스크립트로 실물 재현 완료(수동 검증, 이 pytest는 로직 회귀가드).
"""
from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "disposable_pg.sh"


def _make_stub(path: Path, body: str) -> None:
    path.write_text(f"#!/usr/bin/env bash\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)


@pytest.fixture
def fake_env(tmp_path):
    """ipcs -m이 live(1001)+orphan(2002,3003) 3개 세그를 보고하는 가짜 호스트.
    live postmaster.pid는 1001을 자기 shmid로 자체 기록(7번째 줄, PG 실물 포맷)."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "ipcrm_calls.log"

    _make_stub(bin_dir / "ipcs", f"""
if [ "$1" = "-m" ]; then
  echo "IPC status from <fake> as of now"
  echo "T     ID     KEY        MODE       OWNER    GROUP"
  echo "Shared Memory:"
  echo "m 1001 0x00000000 --rw------- fakeuser  fakeuser"
  echo "m 2002 0x11111111 --rw------- fakeuser  fakeuser"
  echo "m 3003 0x22222222 --rw------- fakeuser  fakeuser"
fi
""")
    _make_stub(bin_dir / "ipcrm", f"""
echo "$@" >> {log}
exit 0
""")
    # pg_ctl start/stop 둘 다 no-op — 이 테스트는 스윕 로직만 pin.
    _make_stub(bin_dir / "pg_ctl", """
echo "pg_ctl $@ (stub, no-op)"
exit 0
""")
    _make_stub(bin_dir / "postgres", "exit 0")

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    # PG postmaster.pid 실물 포맷(7줄) — 7번째 줄이 "key shmid", shmid=1001이 live.
    (data_dir / "postmaster.pid").write_text(
        "12345\n/fake/data\n1700000000\n55999\n/tmp\nlocalhost\n 999999     1001\nready\n"
    )

    env = dict(os.environ)
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    return {"env": env, "data_dir": data_dir, "log": log, "tmp_path": tmp_path}


def test_sweep_removes_orphans_but_excludes_live_shmid(fake_env):
    """live(1001, postmaster.pid 실물 기록)는 ipcrm 대상에서 빠지고 orphan(2002·3003)만
    지워진다 — postmaster.pid 판별이 실제로 작동함을 고정."""
    result = subprocess.run(
        ["bash", str(SCRIPT), str(fake_env["data_dir"]), "55999", "--", "true"],
        env=fake_env["env"], capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr

    removed_ids = fake_env["log"].read_text().split()
    assert "1001" not in removed_ids
    assert "2002" in removed_ids
    assert "3003" in removed_ids


def test_one_shot_mode_runs_command_and_propagates_exit_code(fake_env):
    """`-- <command>` 원샷 모드 — 명령의 종료코드를 그대로 반환한다(트랩이 그 값을 삼키지
    않음, story 본문 «disposable PG 1회 기동+realdb 1건 실행» 판별의 배선 축)."""
    result = subprocess.run(
        ["bash", str(SCRIPT), str(fake_env["data_dir"]), "55999", "--", "bash", "-c", "exit 7"],
        env=fake_env["env"], capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 7


def test_missing_args_usage_error():
    result = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 2
    assert "usage" in result.stderr
