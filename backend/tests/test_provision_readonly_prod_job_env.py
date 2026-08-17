"""story #2402 그라운딩 제안 A(2026-08-17) — provision_readonly_prod_job.sh 회귀가드.

test_deploy_realtime_gce_env.py·test_deploy_env.py와 동일 패턴 — DRY_RUN=1 resolved config를
파싱해 검증한다(gcloud 호출 없음).

핵심 축: ①COMMIT_SHA 미지정 시 fail-fast(story 19754b93 규율 — 이 스크립트가 고치려는
사고 자체가 stale 고정 이미지였다) ②커맨드가 정확히 `alembic current`뿐임(구조로 읽기전용
보장 — AC3 "SELECT만 쓰기로 했다는 약속이 아니라 구조여야 한다"에 대응, upgrade가 문자열
어디에도 없다는 것까지 확認).
"""
from __future__ import annotations

import os
import subprocess

_SCRIPT = os.path.join(os.path.dirname(__file__), "..", "scripts", "provision_readonly_prod_job.sh")


def _resolve(extra: dict | None = None) -> dict[str, str]:
    environ = {**os.environ, "DRY_RUN": "1"}
    environ.pop("COMMIT_SHA", None)
    if extra:
        environ.update(extra)
    proc = subprocess.run(
        ["bash", _SCRIPT], capture_output=True, text=True, env=environ, check=True,
    )
    cfg: dict[str, str] = {}
    for line in proc.stdout.strip().splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip()
    return cfg


def test_missing_commit_sha_fails_fast_without_dry_run():
    """⭐story 19754b93 규율 — COMMIT_SHA 없이 실제 배포 시도하면 floating tag로 새지 않고
    즉시 fail. 이 스크립트가 고치려는 사고(readonly-prod가 08-01 커밋에 16일 고정) 자체가
    "누군가 SHA 없이 손으로 돌렸다"류가 아니라 "SHA를 명시했는데 그 뒤로 안 갱신했다"류지만,
    그래도 이 규율 자체는 다른 모든 prod 잡 스크립트와 동일하게 지킨다."""
    environ = {**os.environ}
    environ.pop("COMMIT_SHA", None)
    environ.pop("DRY_RUN", None)
    proc = subprocess.run(["bash", _SCRIPT], capture_output=True, text=True, env=environ)
    assert proc.returncode != 0
    assert "COMMIT_SHA is not set" in proc.stderr


def test_dry_run_resolves_commit_pinned_image():
    """COMMIT_SHA 지정 시 그 커밋으로 정확히 이미지 태그가 고정된다(floating latest-prod
    아님) — readonly-prod가 애초에 고장난 원인(수동 SHA 고정 후 방치)을 재발시키지 않으려면
    스크립트가 «항상 최신을 명시적으로 넣게» 강제해야 한다."""
    cfg = _resolve({"COMMIT_SHA": "deadbeef1234"})
    assert cfg["IMAGE"] == (
        "asia-northeast3-docker.pkg.dev/sprintable-494803/sprintable/backend:deadbeef1234"
    )
    assert cfg["JOB_NAME"] == "sprintable-readonly-prod"


def test_command_is_exactly_alembic_current_no_upgrade():
    """⭐AC3 — 읽기전용이 «구조»여야 한다. 이 스크립트가 배포할 COMMAND에 upgrade가
    어디에도 없다는 것을 문자열 축으로 직접 확認(story #2399가 잡은 그 병 — 이름은 안전한데
    실제 커맨드에 upgrade가 숨어있는 것 — 의 반대 축을 이 스크립트가 만들지 않는지 검증)."""
    cfg = _resolve({"COMMIT_SHA": "deadbeef1234"})
    assert cfg["COMMAND"] == "sh -c 'cd /app && alembic current'"
    assert "upgrade" not in cfg["COMMAND"]
