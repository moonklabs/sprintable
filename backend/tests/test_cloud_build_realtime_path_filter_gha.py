"""story #3079(2026-08-25) — realtime path-filter(GCE #2089 · Cloud Run #3031) 근본수정.

실 Cloud Build 로그로 확定된 근본원인: `gcloud builds submit --source=.`(로컬소스 tarball
업로드)가 `.gcloudignore` 부재로 gcloud 기본 규칙(`.git` 항상 제외)에 걸려, Cloud Build
워크스페이스엔 `.git`이 아예 없었다 — 두 필터의 `git diff`/`git fetch`가 매번 "Not a git
repository"(rc=129)로 실패해 fail-safe("판별 불가 → 배포 진행")로 상시 떨어졌다(merge 이후
단 한 번도 실제 스킵 없음).

처방: 판정을 `.github/workflows/cloud-build.yml`의 "Resolve realtime deploy path-filter"
스텝(실 `.git` 보유)으로 옮기고, 결과(`gce_skip`/`cloudrun_skip`)만 substitution으로
cloudbuild.yaml에 넘긴다. 이 테스트는 그 GHA 스텝의 구조 계약을 고정한다(cloudbuild.yaml
읽기 쪽 계약은 test_3031_realtime_cloudrun_deploy_path_filter.py가 별도로 고정)."""
from __future__ import annotations

from pathlib import Path

import yaml

_WORKFLOW_PATH = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "cloud-build.yml"


def _load():
    return yaml.safe_load(_WORKFLOW_PATH.read_text())


def _steps():
    return _load()["jobs"]["cloud-build"]["steps"]


def _step(name_substr: str) -> dict:
    for s in _steps():
        if name_substr in (s.get("name") or ""):
            return s
    raise AssertionError(f"step containing {name_substr!r} not found")


def _gate_step() -> dict:
    return _step("Resolve realtime deploy path-filter")


def test_gate_step_only_runs_for_dev_target():
    """GCE·Cloud Run realtime 배포 둘 다 dev 전용이라(cloudbuild.yaml 하드게이트) prod push에서
    이 조회 자체가 낭비·오탐 소지다."""
    step = _gate_step()
    assert step["if"] == "steps.env.outputs.target == 'dev'"


def test_gate_step_unshallows_before_diffing():
    """actions/checkout@v4 기본 fetch-depth=1(shallow)이라 임의 과거 last_sha와의 diff가
    불가능 — unshallow 없이는 이 스텝도 #3079와 같은 클래스로 무력해진다."""
    run = _gate_step()["run"]
    assert "git fetch --unshallow" in run


def test_gate_step_reuses_shared_diff_script_for_both_targets():
    """GCE·Cloud Run 판정 로직이 이중선언되면 안 된다 — 둘 다 SSOT(check_realtime_relevant_diff.sh)
    재사용."""
    run = _gate_step()["run"]
    assert run.count("check_realtime_relevant_diff.sh") == 2


def test_gate_step_reads_serving_revision_not_template_spec_for_cloudrun():
    """describe의 spec.template은 다음 배포 대상이지 실제 트래픽이 아니다(배포 실효=서빙
    리비전 digest 교훈, #2985 조사) — 100% 트래픽 리비전을 명시로 골라야 한다."""
    run = _gate_step()["run"]
    assert "status.traffic.filter(percent=100).revisionName" in run


def test_gate_step_emits_both_skip_outputs():
    run = _gate_step()["run"]
    assert 'echo "gce_skip=${gce_skip}" >> "$GITHUB_OUTPUT"' in run
    assert 'echo "cloudrun_skip=${cloudrun_skip}" >> "$GITHUB_OUTPUT"' in run


def test_gate_step_fails_safe_to_deploy_when_last_sha_unresolvable():
    """GCE last_sha를 못 구하면(최초 배포 등) gce_skip이 여전히 기본값 false(=배포 진행)여야
    한다 — 판별 불가를 스킵으로 오판하면 진짜 변경분을 놓친다."""
    run = _gate_step()["run"]
    gce_branch_start = run.index('if [ -z "${gce_last_sha}" ]; then')
    gce_branch_end = run.index("elif", gce_branch_start)
    gce_branch_body = run[gce_branch_start:gce_branch_end]
    assert "gce_skip=" not in gce_branch_body, "판별 불가 분기에서 gce_skip을 건드리면 초기값(false) 보장이 깨짐"


def test_substitutions_default_missing_gate_output_to_deploy():
    """gate 스텝이 안 도는 경우(prod push)엔 outputs가 빈 문자열 — Assemble 스텝이 이를
    명시로 "false"(배포 진행)로 치환해야 한다."""
    subst_step = _step("Assemble Cloud Build substitutions")
    run = subst_step["run"]
    assert 'V_REALTIME_GCE_SKIP="${V_REALTIME_GCE_SKIP:-false}"' in run
    assert 'V_REALTIME_CLOUDRUN_SKIP="${V_REALTIME_CLOUDRUN_SKIP:-false}"' in run
    assert "_REALTIME_GCE_SKIP=\\\"${V_REALTIME_GCE_SKIP}\\\"" in run
    assert "_REALTIME_CLOUDRUN_SKIP=\\\"${V_REALTIME_CLOUDRUN_SKIP}\\\"" in run
