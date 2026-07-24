"""GCE prod 재배포 핫픽스(2026-07-24, 오르테가 실 재배포 실측) — deploy_realtime_gce.sh
rolling-action 관련 두 결함의 실행 기반(mock gcloud) 회귀가드.

배경: prod 재배포에서 `--max-surge=1`이 regional MIG 제약("0 또는 zone 수 이상")에 걸려
거부됐는데, 그 실패가 "deploy rc=0"으로 보였다 — MIG는 옛 템플릿에 남아있는 채로 성공
처럼 보고된 것. 오늘 이 파일이 걸린 세 번째 같은 클래스 결함(delete+recreate·
maxUnavailable에 이어)이라 "실행 없이는 gcloud API 제약을 코드리뷰로 못 잡는다"는 교훈이
반복됐다 — 이 테스트는 실 GCP 접근 없이도(mock gcloud 함수) 그 실행 층 자체를 고정한다.

⚠️DRY_RUN=1은 이 로직 자체를 건너뛴다(라인 486의 exit 0 — 실 gcloud 호출부 진입 前). 그래서
기존 test_deploy_realtime_gce_env.py의 DRY_RUN 패턴으로는 이 결함을 원천적으로 못 잡는다.
이 파일은 DRY_RUN=0으로 스크립트를 실제로 끝까지 돌리되, PATH에 mock gcloud 함수를 얹어
실 GCP 호출 없이 그 실행 경로를 그대로 태운다.
"""
from __future__ import annotations

import os
import subprocess
import textwrap

_SCRIPT = os.path.join(os.path.dirname(__file__), "..", "scripts", "deploy_realtime_gce.sh")


def _mock_gcloud_script(*, rolling_action_exit: int, zone_count: int) -> str:
    """실행 경로를 그대로 태우기 위한 최소 mock — dev 시나리오(템플릿·MIG 둘 다 이미 존재
    → rolling-update 분기)만 커버한다. 인자 패턴 매칭으로 각 서브커맨드에 필요한 최소
    응답만 돌려준다(실 gcloud 응답 그대로 흉내낼 필요 없음 — 이 스크립트의 소비 로직만
    검증 대상)."""
    zones_json = ", ".join(f'{{"zone": "z{i}"}}' for i in range(zone_count))
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
                echo '{{"distributionPolicy": {{"zones": [{zones_json}]}}}}'
                exit 0
                ;;
            *"instance-groups managed describe"*)
                exit 0  # MIG 이미 존재 — rolling-update 분기 진입.
                ;;
            *"rolling-action start-update"*)
                echo "$args" >> "${{MOCK_ROLLING_ACTION_ARGS_FILE}}"
                if [ "{rolling_action_exit}" != "0" ]; then
                    echo "ERROR: Invalid value for 'updatePolicy.maxSurge.fixed'" >&2
                fi
                exit {rolling_action_exit}
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


def _run_script(tmp_path, *, rolling_action_exit: int, zone_count: int):
    mock_bin_dir = tmp_path / "mockbin"
    mock_bin_dir.mkdir()
    gcloud_path = mock_bin_dir / "gcloud"
    gcloud_path.write_text(
        _mock_gcloud_script(rolling_action_exit=rolling_action_exit, zone_count=zone_count)
    )
    gcloud_path.chmod(0o755)

    log_file = tmp_path / "mock_calls.log"
    rolling_args_file = tmp_path / "rolling_action_args.txt"
    log_file.write_text("")
    rolling_args_file.write_text("")

    env = {
        **os.environ,
        "PATH": f"{mock_bin_dir}:{os.environ['PATH']}",
        "DRY_RUN": "0",
        "COMMIT_SHA": "deadbeef",
        # dev 분기의 하드코딩 MIG_NAME(스크립트 내부 변수) — mock gcloud는 별도 프로세스라
        # 스크립트 내부 변수를 못 보므로, backend-services describe mock 응답에 같은 이름을
        # 실어주기 위해 여기서도 명시(스크립트 값과 반드시 동일해야 함).
        "MIG_NAME": "sprintable-realtime-gateway-dev",
        "MOCK_GCLOUD_LOG": str(log_file),
        "MOCK_ROLLING_ACTION_ARGS_FILE": str(rolling_args_file),
    }
    proc = subprocess.run(
        ["bash", _SCRIPT, "dev"],
        capture_output=True, text=True, env=env,
    )
    rolling_args = rolling_args_file.read_text().strip()
    return proc, rolling_args


def test_rolling_action_failure_is_surfaced_not_swallowed(tmp_path):
    """⭐핵심 회귀가드 — rolling-action이 비-0 종료해도 스크립트가 조용히 rc=0으로 넘어가지
    않는다(오늘 실측된 결함 그대로). 명시 FAIL: 마커 + 최종 종료코드 != 0 둘 다 확인."""
    proc, _ = _run_script(tmp_path, rolling_action_exit=1, zone_count=3)
    assert proc.returncode != 0, (
        f"rolling-action 실패인데도 스크립트가 rc=0으로 종료됨(오늘 실측된 바로 그 결함) — "
        f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    )
    assert "FAIL:" in proc.stdout, f"명시 실패 마커 없음 — stdout={proc.stdout!r}"


def test_rolling_action_max_surge_uses_live_zone_count_not_hardcoded_1(tmp_path):
    """⭐prod 재배포에서 거부된 --max-surge=1 하드코딩을 회귀 방지 — 실 zone 수(mock=3)를
    그대로 반영해 호출하는지 확인. 하드코딩 "3"도 아니고(dev/prod 어느 쪽이든) MIG가
    실제로 걸친 zone 수를 그대로 쓰는지가 핵심(다른 zone 수로도 검증)."""
    _, rolling_args = _run_script(tmp_path, rolling_action_exit=0, zone_count=3)
    assert "--max-surge=3" in rolling_args, f"got: {rolling_args!r}"
    assert "--max-surge=1" not in rolling_args, "구 하드코딩 값(1)이 여전히 쓰이고 있음"


def test_rolling_action_max_surge_tracks_different_zone_count(tmp_path):
    """zone 수가 3이 아닌 경우(예: 5)에도 그 실측값을 그대로 따라가는지 — 이번엔 "3"으로
    하드코딩을 바꿔치기하는 회귀까지 잡는다(1→3 치환만으로는 다음에 zone 수가 또 바뀌면
    똑같이 재발한다)."""
    _, rolling_args = _run_script(tmp_path, rolling_action_exit=0, zone_count=5)
    assert "--max-surge=5" in rolling_args, f"got: {rolling_args!r}"


def test_rolling_action_success_reaches_end_of_script(tmp_path):
    """정상 종료 시(rolling-action 성공) 스크립트가 끝까지 도달해 rc=0으로 마친다 — 위
    실패 케이스와의 대조군(무회귀 확인)."""
    proc, _ = _run_script(tmp_path, rolling_action_exit=0, zone_count=3)
    assert proc.returncode == 0, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    # log()는 stderr로 쓴다(이 스크립트 전체 컨벤션 — DRY_RUN의 stdout KEY=VALUE 출력과 분리).
    assert "Deployment submitted" in proc.stderr
