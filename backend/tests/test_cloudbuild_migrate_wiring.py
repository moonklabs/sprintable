"""story dbda0baf(E-RECRUIT S13): cloudbuild.yaml — migrate 잡이 배포 파이프라인에
SHA-pinned 이미지로 자동 배선돼 있고, 실패 시 backend 배포가 abort되는지 구조 검증.

근본원인(2026-07-05 dev 인시던트): migrate 잡이 파이프라인과 완전히 분리돼 있어
COMMIT_SHA 없이 수동 provision하면 mutable `latest-${ENV}` 태그에 고정되고,
잡 자체가 인라인 `head`(단수)로 드리프트해도 아무도 감지 못했다.
"""
from __future__ import annotations

import os

import yaml

_CLOUDBUILD = os.path.join(os.path.dirname(__file__), "..", "..", "cloudbuild.yaml")


def _load():
    with open(_CLOUDBUILD) as f:
        return yaml.safe_load(f)


def _steps_by_id(doc):
    return {s["id"]: s for s in doc["steps"]}


def test_cloudbuild_yaml_is_valid():
    doc = _load()
    assert "steps" in doc


def test_migrate_job_step_uses_provision_script_not_inline_gcloud():
    """canonical provision_migrate_job.sh를 통해 잡을 갱신 — 인라인 ad-hoc gcloud 커맨드로
    드리프트가 재발할 수 없게 한다."""
    steps = _steps_by_id(_load())
    assert "update-migrate-job" in steps
    src = " ".join(steps["update-migrate-job"]["args"])
    assert "provision_migrate_job.sh" in src


def test_migrate_job_step_pins_commit_sha_not_floating_tag():
    """COMMIT_SHA를 명시 주입 — provision_migrate_job.sh가 latest-${ENV}로 폴백하지 않게."""
    steps = _steps_by_id(_load())
    src = " ".join(steps["update-migrate-job"]["args"])
    assert "COMMIT_SHA=" in src
    assert "${COMMIT_SHA}" in src


def test_migrate_job_executes_and_waits():
    steps = _steps_by_id(_load())
    assert "run-migrate-job" in steps
    args = steps["run-migrate-job"]["args"]
    assert "execute" in args
    assert "--wait" in args
    assert steps["run-migrate-job"]["waitFor"] == ["update-migrate-job"]


def test_deploy_backend_blocked_by_migrate_job():
    """핵심 AC: migrate 실패 시 배포 자동 abort — deploy-backend가 run-migrate-job에
    waitFor로 의존해야 마이그 실패가 배포를 막는다(과거엔 push-backend에만 의존해
    마이그와 무관하게 배포됐다)."""
    steps = _steps_by_id(_load())
    assert steps["deploy-backend"]["waitFor"] == ["run-migrate-job"]


def test_migrate_pipeline_precedes_deploy_in_step_order():
    doc = _load()
    ids = [s["id"] for s in doc["steps"]]
    assert ids.index("update-migrate-job") < ids.index("run-migrate-job")
    assert ids.index("run-migrate-job") < ids.index("deploy-backend")
