"""story #3031(2026-08-24, 원안) → story #3079(2026-08-25, 근본수정)로 대체.

원안(#3031)은 cloudbuild.yaml `deploy-realtime` 스텝 안에서 직접 `git diff`/서빙 리비전
조회를 했으나, 실 Cloud Build 로그로 그 판정이 **단 한 번도 실제로 스킵을 실행한 적이
없었다**는 게 드러났다(#3079 그라운딩) — Cloud Build가 로컬소스(tarball) 업로드로 도는데
레포에 `.gcloudignore`가 없어 `.git`이 워크스페이스에 아예 없고, `git diff`가 매번 "Not a
git repository"(rc=129)로 실패해 fail-safe("판별 불가 → 배포 진행")로 항상 떨어졌다.

처방(#3079): 판정을 Cloud Build 밖(GHA, 실 `.git` 보유 — `.github/workflows/cloud-build.yml`
"Resolve realtime deploy path-filter" 스텝, 회귀가드는
`test_cloud_build_realtime_path_filter_gha.py`)으로 옮기고, cloudbuild.yaml `deploy-realtime`
스텝은 그 결과(`_REALTIME_CLOUDRUN_SKIP` substitution)만 읽는다. 이 파일은 그 단순화된
읽기-전용 계약만 고정한다."""
from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CLOUDBUILD_YAML = _REPO_ROOT / "cloudbuild.yaml"


def _deploy_realtime_step_script() -> str:
    import yaml

    doc = yaml.safe_load(_CLOUDBUILD_YAML.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "deploy-realtime")
    assert step["entrypoint"] == "bash"
    return step["args"][1]


def test_deploy_realtime_no_longer_attempts_git_diff_inside_cloud_build():
    """#3079 회귀 방지 핵심 — Cloud Build 안에서 git diff/서빙 리비전 재조회를 다시 하면
    같은 결함(rc=129 fail-safe 상시배포)이 재발한다. 이 스텝은 GHA가 넘긴 skip 플래그만
    읽어야 한다."""
    script = _deploy_realtime_step_script()
    assert "git diff" not in script
    assert "git fetch" not in script
    assert "check_realtime_relevant_diff.sh" not in script


def test_deploy_realtime_reads_gha_computed_skip_flag():
    script = _deploy_realtime_step_script()
    assert '"${_REALTIME_CLOUDRUN_SKIP}" = "true"' in script


def test_deploy_realtime_skip_branch_exits_before_actual_deploy():
    """스킵 결정이 실제 `gcloud run deploy`보다 앞서야 한다 — 순서가 뒤바뀌면 스킵이 무의미."""
    script = _deploy_realtime_step_script()
    lines = script.splitlines()
    skip_line_idx = next(
        i for i, l in enumerate(lines)
        if "skip deploy-realtime:" in l and "story #3079" in l
    )
    deploy_line_idx = next(
        i for i, l in enumerate(lines)
        if "gcloud run deploy sprintable-realtime-${_DEPLOY_ENV}" in l
    )
    assert skip_line_idx < deploy_line_idx, "path-filter 스킵 판단이 실제 배포 커맨드보다 뒤에 있음"

    next_nonblank = next(l.strip() for l in lines[skip_line_idx + 1:] if l.strip())
    assert next_nonblank == "exit 0", (
        f"스킵 echo 바로 다음 줄이 'exit 0'가 아님(실제: {next_nonblank!r}) — "
        "로그만 찍고 실제로 안 빠져나가면 그 아래 배포가 그대로 실행됨"
    )
