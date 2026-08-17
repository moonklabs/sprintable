"""story #2182(2026-08-17, 미르코 실측) — deploy_realtime_gce.sh의 MIG create 호출 2곳
회귀가드(mock gcloud).

배경: regional MIG의 silent default는 instance-redistribution-type=proactive다. SSE는
long-lived라 이 자발적 zone 재분배가 시작될 때마다 1~3분 내 502 버스트가 뜨는 것을
분단위 상관대조+음성대조(재분배 없는 구간 502=0건)로 확定했다. dev MIG의 라이브 값은
--instance-redistribution-type=none으로 이미 전환했으나, 그 값은 create 경로(신규 생성·
FORCE_MIG_RECREATE 강제재생성)를 다시 타면 스크립트가 명시하지 않는 한 도로 proactive로
되돌아간다 — 이 테스트는 그 명시가 실제로 두 create 호출 모두에 실려 나가는지 고정한다.
"""
from __future__ import annotations

import os
import subprocess
import textwrap

_SCRIPT = os.path.join(os.path.dirname(__file__), "..", "scripts", "deploy_realtime_gce.sh")


def _mock_gcloud_script(*, mig_exists: bool) -> str:
    mig_describe_exit = 0 if mig_exists else 1
    return textwrap.dedent(f"""\
        #!/usr/bin/env bash
        set -euo pipefail
        args="$*"
        echo "MOCK_GCLOUD_CALL: $args" >> "${{MOCK_GCLOUD_LOG}}"

        case "$args" in
            *"instance-templates describe"*)
                exit 0  # 템플릿 이미 존재 — create 스킵.
                ;;
            *"instance-groups managed describe"*"format=json(distributionPolicy.zones)"*)
                echo '{{"distributionPolicy": {{"zones": [{{"zone": "z1"}}, {{"zone": "z2"}}, {{"zone": "z3"}}]}}}}'
                exit 0
                ;;
            *"instance-groups managed describe"*)
                exit {mig_describe_exit}
                ;;
            *"instance-groups managed create"*)
                echo "$args" >> "${{MOCK_CREATE_ARGS_FILE}}"
                exit 0
                ;;
            *"rolling-action start-update"*)
                exit 0
                ;;
            *"set-named-ports"*)
                exit 0
                ;;
            *"backend-services describe"*)
                echo "https://.../instanceGroups/${{MIG_NAME:-mig}}"
                exit 0
                ;;
            *)
                exit 0
                ;;
        esac
        """)


def _run_script(tmp_path, *, mig_exists: bool, force_recreate: bool = False):
    mock_bin_dir = tmp_path / "mockbin"
    mock_bin_dir.mkdir()
    gcloud_path = mock_bin_dir / "gcloud"
    gcloud_path.write_text(_mock_gcloud_script(mig_exists=mig_exists))
    gcloud_path.chmod(0o755)

    log_file = tmp_path / "mock_calls.log"
    create_args_file = tmp_path / "create_args.txt"
    log_file.write_text("")
    create_args_file.write_text("")

    env = {
        **os.environ,
        "PATH": f"{mock_bin_dir}:{os.environ['PATH']}",
        "DRY_RUN": "0",
        "COMMIT_SHA": "deadbeef",
        "MIG_NAME": "sprintable-realtime-gateway-dev",
        "MOCK_GCLOUD_LOG": str(log_file),
        "MOCK_CREATE_ARGS_FILE": str(create_args_file),
    }
    if force_recreate:
        env["FORCE_MIG_RECREATE"] = "1"

    proc = subprocess.run(
        ["bash", _SCRIPT, "dev"],
        capture_output=True, text=True, env=env,
    )
    create_args = create_args_file.read_text().strip()
    return proc, create_args


def test_fresh_mig_create_includes_redistribution_type_none(tmp_path):
    """⭐신규 MIG(존재하지 않는 경우) create 호출에 --instance-redistribution-type=none이
    실린다 — 이게 빠지면 silent default(proactive)로 502 버스트 재발."""
    proc, create_args = _run_script(tmp_path, mig_exists=False)
    assert "--instance-redistribution-type=none" in create_args, (
        f"신규 MIG create에 플래그 누락 — got: {create_args!r} (stdout={proc.stdout!r})"
    )


def test_force_recreate_mig_create_includes_redistribution_type_none(tmp_path):
    """⭐FORCE_MIG_RECREATE=1(강제재생성) 경로도 동일 — delete 後 create 호출에 실려야 한다."""
    proc, create_args = _run_script(tmp_path, mig_exists=True, force_recreate=True)
    assert "--instance-redistribution-type=none" in create_args, (
        f"강제재생성 create에 플래그 누락 — got: {create_args!r} (stdout={proc.stdout!r})"
    )
