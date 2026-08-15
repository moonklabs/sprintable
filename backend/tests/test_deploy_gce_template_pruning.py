"""story #2673(2026-08-15, 실사고: dev 배포가 quota INSTANCE_TEMPLATES(한도 300) 소진으로
실패 — 실측 470개, dev 게이트웨이만 463개·실사용 1개) — deploy_realtime_gce.sh가 배포 성공
후 옛 인스턴스 템플릿을 스스로 정리하는지 확인하는 실행 기반(mock gcloud) 회귀가드.

⚠️DRY_RUN=1은 이 로직 자체를 건너뛴다(gcloud 실 호출부 진입 前 exit 0) —
test_deploy_gce_rolling_update_maxsurge_failfast.py와 동일 이유로 DRY_RUN=0 +
PATH mock gcloud 패턴을 재사용한다(신규 발명 아님)."""
from __future__ import annotations

import os
import subprocess
import textwrap

_SCRIPT = os.path.join(os.path.dirname(__file__), "..", "scripts", "deploy_realtime_gce.sh")


def _mock_gcloud_script(*, template_names: list[str], delete_should_fail_for: set[str] | None = None) -> str:
    """rolling-update 분기(템플릿·MIG 둘 다 이미 존재)까지는 기존 회귀가드 파일과 동일
    최소 mock — 그 뒤 프루닝 단계(list/delete)만 이 파일 전용으로 추가한다.

    `instance-templates list`는 실 gcloud가 `--sort-by=~creationTimestamp`로 이미 최신순
    정렬해 돌려주는 것을 흉내내 `template_names`를 그 순서 그대로(내림차순 가정) 반환한다
    — 정렬 로직 자체는 gcloud 서버측 책임이라 mock 대상이 아니다(이 스크립트의 소비 로직
    — tail로 앞 N개를 건너뛰는 것 — 만 검증 대상)."""
    delete_should_fail_for = delete_should_fail_for or set()
    names_lines = "\n".join(f'echo "{n}"' for n in template_names)
    fail_cases = "\n".join(
        f'*"instance-templates delete {n} "*) exit 1 ;;' for n in delete_should_fail_for
    )
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
                echo '{{"distributionPolicy": {{"zones": [{{"zone": "za"}}, {{"zone": "zb"}}, {{"zone": "zc"}}]}}}}'
                exit 0
                ;;
            *"instance-groups managed describe"*)
                exit 0  # MIG 이미 존재 — rolling-update 분기 진입.
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
            *"instance-templates list "*)
                echo "$args" >> "${{MOCK_TEMPLATES_LIST_ARGS_FILE}}"
{textwrap.indent(names_lines, ' ' * 16) if names_lines else ''}
                exit 0
                ;;
            {fail_cases}
            *"instance-templates delete "*)
                echo "$args" >> "${{MOCK_TEMPLATES_DELETE_ARGS_FILE}}"
                exit 0
                ;;
            *)
                exit 0
                ;;
        esac
        """)


def _run_script(tmp_path, *, template_names: list[str], delete_should_fail_for: set[str] | None = None,
                 extra_env: dict | None = None):
    mock_bin_dir = tmp_path / "mockbin"
    mock_bin_dir.mkdir()
    gcloud_path = mock_bin_dir / "gcloud"
    gcloud_path.write_text(
        _mock_gcloud_script(template_names=template_names, delete_should_fail_for=delete_should_fail_for)
    )
    gcloud_path.chmod(0o755)

    log_file = tmp_path / "mock_calls.log"
    list_args_file = tmp_path / "templates_list_args.txt"
    delete_args_file = tmp_path / "templates_delete_args.txt"
    for f in (log_file, list_args_file, delete_args_file):
        f.write_text("")

    env = {
        **os.environ,
        "PATH": f"{mock_bin_dir}:{os.environ['PATH']}",
        "DRY_RUN": "0",
        "COMMIT_SHA": "deadbeef",
        "MIG_NAME": "sprintable-realtime-gateway-dev",
        "MOCK_GCLOUD_LOG": str(log_file),
        "MOCK_TEMPLATES_LIST_ARGS_FILE": str(list_args_file),
        "MOCK_TEMPLATES_DELETE_ARGS_FILE": str(delete_args_file),
    }
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(["bash", _SCRIPT, "dev"], capture_output=True, text=True, env=env)
    deleted = [l for l in delete_args_file.read_text().splitlines() if l.strip()]
    list_args = list_args_file.read_text().strip()
    return proc, deleted, list_args


def _deleted_names(deleted_lines: list[str]) -> list[str]:
    out = []
    for line in deleted_lines:
        # "compute instance-templates delete <name> --project=... --quiet"
        parts = line.split()
        idx = parts.index("delete")
        out.append(parts[idx + 1])
    return out


def test_prune_keeps_latest_n_deletes_the_rest(tmp_path):
    """AC1/AC3 — 최신순으로 이미 정렬돼 돌아온 8개 중 기본 keep=5를 넘는 뒤쪽 3개만 삭제된다."""
    names = [f"sprintable-realtime-gateway-dev-{i:02d}" for i in range(8)]  # 00이 최신
    proc, deleted, _ = _run_script(tmp_path, template_names=names)
    assert proc.returncode == 0, f"stdout={proc.stdout!r} stderr={proc.stderr!r}"
    assert _deleted_names(deleted) == names[5:], f"got: {_deleted_names(deleted)!r}"


def test_prune_within_keep_window_deletes_nothing(tmp_path):
    """음성대조 — 템플릿 수가 keep 이하면 삭제 호출 자체가 0건."""
    names = [f"sprintable-realtime-gateway-dev-{i:02d}" for i in range(3)]
    proc, deleted, _ = _run_script(tmp_path, template_names=names)
    assert proc.returncode == 0
    assert deleted == []


def test_prune_respects_env_override_keep_count(tmp_path):
    """GCE_TEMPLATE_PRUNE_KEEP override — 기본 5가 아니라 명시값을 쓴다."""
    names = [f"sprintable-realtime-gateway-dev-{i:02d}" for i in range(8)]
    proc, deleted, _ = _run_script(tmp_path, template_names=names, extra_env={"GCE_TEMPLATE_PRUNE_KEEP": "2"})
    assert proc.returncode == 0
    assert _deleted_names(deleted) == names[2:]


def test_prune_filter_scoped_to_this_env_prefix_only(tmp_path):
    """음성대조 — list 호출의 --filter가 이 env(dev)의 TEMPLATE_PREFIX로만 좁혀져 있다
    (prod 템플릿이 같은 목록에 섞여 삭제 대상이 되지 않는다는 것의 대리 확인 — mock
    자체는 필터를 해석하지 않으므로, 스크립트가 gcloud에 «올바른 필터 문자열»을
    넘기는지를 직접 확인한다)."""
    _, _, list_args = _run_script(tmp_path, template_names=[])
    assert "name~^sprintable-realtime-gateway-dev-" in list_args, f"got: {list_args!r}"
    assert "prod" not in list_args


def test_prune_delete_failure_is_non_fatal_deploy_still_succeeds(tmp_path):
    """⭐AC2 핵심 — in-use 등으로 삭제가 거부돼도(비-0 종료) 전체 배포는 여전히 rc=0으로
    끝나고 "Deployment submitted"까지 도달한다(프루닝은 배포 본체와 격리된 정리 단계)."""
    names = [f"sprintable-realtime-gateway-dev-{i:02d}" for i in range(7)]
    fail_targets = {names[5], names[6]}
    proc, deleted, _ = _run_script(tmp_path, template_names=names, delete_should_fail_for=fail_targets)
    assert proc.returncode == 0, f"프루닝 실패가 배포 성공을 뒤집으면 안 된다 — stderr={proc.stderr!r}"
    assert "Deployment submitted" in proc.stderr
    # 프루닝 대상 2개(names[5:])가 전부 fail_targets이므로 성공 로그(exit 1 케이스는
    # MOCK_TEMPLATES_DELETE_ARGS_FILE에 안 적도록 mock을 설계했다)는 0건이어야 한다.
    assert set(names[5:]) == fail_targets
    assert deleted == [], f"둘 다 실패 지정이라 성공 로그는 0건이어야 — got {deleted!r}"


def test_prune_no_templates_found_is_non_fatal(tmp_path):
    """음성대조 — list가 빈 결과를 돌려줘도(신규 env·최초 배포 등) 정상 종료."""
    proc, deleted, _ = _run_script(tmp_path, template_names=[])
    assert proc.returncode == 0
    assert deleted == []
    assert "Deployment submitted" in proc.stderr


def test_prune_runs_after_deployment_success_log_order(tmp_path):
    """프루닝 로그가 실제로 "Deployment submitted" 이전(배포 본체 확定 後)에 나오는지 —
    순서 자체가 AC1("배포 성공 확定 後")의 실행 증거."""
    names = [f"sprintable-realtime-gateway-dev-{i:02d}" for i in range(6)]
    proc, _, _ = _run_script(tmp_path, template_names=names)
    stderr = proc.stderr
    prune_idx = stderr.find("Pruning old instance templates")
    submitted_idx = stderr.find("Deployment submitted")
    assert prune_idx != -1 and submitted_idx != -1, f"stderr={stderr!r}"
    assert prune_idx < submitted_idx
