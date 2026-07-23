"""story #2141(E-ARCH, 2026-07-23): cloudbuild.yaml deploy-backend REDIS_URL env/secret 충돌 방지.

Cloud Build 스텝은 DRY_RUN 모드가 없어(gcloud CLI 스크립트와 다름) deploy_realtime_gce.sh류
DRY_RUN 검증을 그대로 못 쓴다 — 대신 ENV_VARS 조립 로직을 cloudbuild.yaml에서 그대로 추출해
독립 실행하고 dev/prod의 REDIS_URL 포함 여부를 검증한다(오르테가 확定 산출물).
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

import yaml

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CLOUDBUILD_YAML = _REPO_ROOT / "cloudbuild.yaml"


def _extract_deploy_backend_script() -> str:
    """cloudbuild.yaml의 deploy-backend 스텝 bash 스크립트 본문을 그대로 추출."""
    doc = yaml.safe_load(_CLOUDBUILD_YAML.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "deploy-backend")
    assert step["entrypoint"] == "bash", "deploy-backend가 더 이상 bash entrypoint가 아님 — 이 테스트 갱신 필요"
    # args: ["-c", "<script>"]
    return step["args"][1]


def _run_env_vars_assembly(deploy_env: str, redis_url: str) -> str:
    """실제 gcloud 호출부만 잘라내고 ENV_VARS 조립 로직까지만 실행 — 실제 배포 없이 결과 문자열만 얻는다."""
    script = _extract_deploy_backend_script()
    # 실제 gcloud run deploy 호출 라인 이후는 잘라내고 ENV_VARS를 echo하도록 붙인다.
    # ⚠️"gcloud run deploy"만으로 찾으면 그 문구를 언급하는 주석(설명 문장)에 먼저 매치된다 —
    # 실제 호출부에만 있는 서비스명까지 포함해 정확히 그 라인을 찾는다.
    marker = "gcloud run deploy sprintable-backend"
    idx = script.index(marker)
    assembly_only = script[:idx] + '\necho "RESULT_ENV_VARS=${ENV_VARS}"\n'

    env = {
        **os.environ,
        "_DEPLOY_ENV": deploy_env,
        "_FASTAPI_URL": "https://example.run.app",
        "_BACKEND_PG_LISTEN_ENABLED": "true",
        "_BACKEND_REDIS_CONSUME_ENABLED": "false",
        "_BACKEND_REDIS_DISPATCH_ENABLED": "false",
        "_BACKEND_REDIS_DUAL_PUBLISH_ENABLED": "false",
        "_BACKEND_FANOUT_WAKE_REDIS_ENABLED": "false",
        "_REDIS_URL": redis_url,
    }
    proc = subprocess.run(
        ["bash", "-c", assembly_only],
        capture_output=True, text=True, env=env, check=True,
    )
    for line in proc.stdout.splitlines():
        if line.startswith("RESULT_ENV_VARS="):
            return line[len("RESULT_ENV_VARS="):]
    raise AssertionError(f"ENV_VARS not found in output: {proc.stdout!r}")


def test_deploy_backend_is_bash_entrypoint():
    """story #2141 정정 — env 조건분기를 위해 gcloud 단순 args에서 bash로 전환됐다."""
    doc = yaml.safe_load(_CLOUDBUILD_YAML.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "deploy-backend")
    assert step["entrypoint"] == "bash"
    assert "set -euo pipefail" in step["args"][1], "실패 시 배포가 조용히 반쪽 되지 않도록 하는 안전장치 누락"


def test_deploy_backend_dev_includes_plain_redis_url():
    """dev: AUTH 없는 plain Memorystore — 시크릿 바인딩이 없으므로 기존처럼 plain env로 넘긴다."""
    result = _run_env_vars_assembly("dev", "redis://10.164.120.243:6379")
    assert "REDIS_URL=redis://10.164.120.243:6379" in result


def test_deploy_backend_prod_excludes_plain_redis_url():
    """⭐#2141 핵심 AC — prod는 REDIS_URL을 절대 plain env로 안 넘긴다(Secret Manager 바인딩과
    동명 충돌 방지, 값의 유무와 무관하게 키 자체가 없어야 한다)."""
    result = _run_env_vars_assembly("prod", "")
    assert "REDIS_URL" not in result


def test_deploy_backend_dev_env_vars_unchanged_by_prod_branch():
    """dev 경로 무회귀 — prod 분기 추가가 dev의 다른 필드에 영향을 주지 않는다."""
    result = _run_env_vars_assembly("dev", "redis://10.164.120.243:6379")
    assert result == (
        "FASTAPI_URL=https://example.run.app,DB_POOL_SIZE=3,DB_MAX_OVERFLOW=1,"
        "PG_LISTEN_ENABLED=true,EVENT_BROKER_REDIS_CONSUME_ENABLED=false,"
        "EVENT_BROKER_REDIS_DISPATCH_ENABLED=false,EVENT_BROKER_REDIS_DUAL_PUBLISH_ENABLED=false,"
        "FANOUT_WAKE_REDIS_ENABLED=false,REDIS_URL=redis://10.164.120.243:6379"
    )
