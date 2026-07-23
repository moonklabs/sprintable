"""story #2142(E-ARCH, 2026-07-23): GCE realtime-gateway 배포 스크립트 dev/prod 분기 검증.

test_deploy_env.py(deploy_backend.sh 등)와 동일 패턴 — DRY_RUN=1 resolved config를
파싱해 dev/prod 경로를 검증한다.
"""
from __future__ import annotations

import os
import subprocess

_SCRIPTS = os.path.join(os.path.dirname(__file__), "..", "scripts")
_DEPLOY_GCE = os.path.join(_SCRIPTS, "deploy_realtime_gce.sh")
_PROVISION_GCLB = os.path.join(_SCRIPTS, "provision_realtime_gclb.sh")


def _resolve(script: str, env: str, extra: dict | None = None) -> dict[str, str]:
    """스크립트를 DRY_RUN=1로 실행하고 KEY=VALUE stdout을 dict로 파싱(stderr의 log()는 무시)."""
    environ = {**os.environ, "DRY_RUN": "1"}
    if extra:
        environ.update(extra)
    proc = subprocess.run(
        ["bash", script, env],
        capture_output=True, text=True, env=environ, check=True,
    )
    cfg: dict[str, str] = {}
    for line in proc.stdout.strip().splitlines():
        if "=" in line:
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip()
    return cfg


# ── deploy_realtime_gce.sh ───────────────────────────────────────────────────

def test_deploy_gce_dev_targets_dev_instance():
    cfg = _resolve(_DEPLOY_GCE, "dev")
    assert cfg["MIG_NAME"] == "sprintable-realtime-gateway-dev"
    assert cfg["SQL_INSTANCE_CONN"].endswith(":sprintable-dev")
    assert "DATABASE_URL_DEV:DATABASE_URL" in cfg["SECRET_PAIRS"]


def test_deploy_gce_prod_targets_prod_instance():
    cfg = _resolve(_DEPLOY_GCE, "prod")
    assert cfg["MIG_NAME"] == "sprintable-realtime-gateway-prod"
    assert cfg["SQL_INSTANCE_CONN"].endswith(":sprintable-prod")
    assert "DATABASE_URL_PROD:DATABASE_URL" in cfg["SECRET_PAIRS"]


def test_deploy_gce_dev_and_prod_are_separated():
    """핵심 AC: 양 경로가 서로 다른 인스턴스·시크릿·MIG명."""
    dev = _resolve(_DEPLOY_GCE, "dev")
    prod = _resolve(_DEPLOY_GCE, "prod")
    assert dev["SQL_INSTANCE_CONN"] != prod["SQL_INSTANCE_CONN"]
    assert dev["MIG_NAME"] != prod["MIG_NAME"]
    assert dev["SECRET_PAIRS"] != prod["SECRET_PAIRS"]


def test_deploy_gce_mcp_public_url_env_specific():
    """story #2142(오르테가 라이브 실측 2026-07-23) — DATABASE_URL_DEV와 같은 클래스로
    발견된 env 분기 밖 리터럴 재발 방지."""
    dev = _resolve(_DEPLOY_GCE, "dev")
    prod = _resolve(_DEPLOY_GCE, "prod")
    assert "MCP_PUBLIC_URL=https://dev-mcp.sprintable.ai/mcp" in dev["PLAIN_ENV_SPEC"]
    assert "MCP_PUBLIC_URL=https://mcp.sprintable.ai/mcp" in prod["PLAIN_ENV_SPEC"]


def test_deploy_gce_prod_secret_pairs_no_dev_leak():
    """story #2142 회귀 방지 — DB_SECRET_NAME 미사용으로 prod 플랜에 dev 시크릿이
    하드코딩 리터럴로 섞여 들어가던 결함(발견 즉시 수정)의 재발 차단."""
    cfg = _resolve(_DEPLOY_GCE, "prod")
    assert "DEV" not in cfg["SECRET_PAIRS"]
    assert "-dev" not in cfg["SECRET_PAIRS"]


def test_deploy_gce_dev_secret_pairs_unchanged():
    """dev 경로는 이번 변경으로 한 글자도 안 바뀌어야 한다(오르테가 명시 AC)."""
    cfg = _resolve(_DEPLOY_GCE, "dev")
    assert cfg["SECRET_PAIRS"] == (
        "DATABASE_URL_DEV:DATABASE_URL JWT_SECRET:JWT_SECRET GOOGLE_CLIENT_ID:GOOGLE_CLIENT_ID "
        "GOOGLE_CLIENT_SECRET:GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID_DEV:GITHUB_CLIENT_ID "
        "GITHUB_CLIENT_SECRET_DEV:GITHUB_CLIENT_SECRET RESEND_API_KEY:RESEND_API_KEY "
        "EMAIL_FROM:EMAIL_FROM github-webhook-secret:GITHUB_WEBHOOK_SECRET "
        "cron-secret:CRON_SECRET github-app-client-secret-dev:GITHUB_APP_CLIENT_SECRET "
        "github-app-private-key-dev:GITHUB_APP_PRIVATE_KEY "
        "github-app-state-secret-dev:GITHUB_APP_STATE_SECRET "
        "FIREBASE_BFF_INTERNAL_SECRET:FIREBASE_BFF_INTERNAL_SECRET "
        "DATABASE_URL_DEV:DATABASE_URL_DEV"
    )


def test_deploy_gce_invalid_env_rejected():
    proc = subprocess.run(
        ["bash", _DEPLOY_GCE, "staging"],
        capture_output=True, text=True,
        env={**os.environ, "DRY_RUN": "1"},
    )
    assert proc.returncode != 0
    assert "[dev|prod]" in proc.stderr


# ── provision_realtime_gclb.sh ───────────────────────────────────────────────

def test_provision_gclb_dev_targets_dev_resources():
    cfg = _resolve(_PROVISION_GCLB, "dev")
    assert cfg["MIG_NAME"] == "sprintable-realtime-gateway-dev"
    assert "3600" in cfg["BACKEND_SERVICE_NAME"]  # "(timeout=3600s, draining=120s)" 접미 확認


def test_provision_gclb_prod_targets_prod_resources():
    cfg = _resolve(_PROVISION_GCLB, "prod")
    assert cfg["MIG_NAME"] == "sprintable-realtime-gateway-prod"
    assert "3600" in cfg["BACKEND_SERVICE_NAME"]


def test_provision_gclb_prod_timeout_matches_dev():
    """⚠️이 스크립트의 존재 이유 — timeout=3600이 prod에서도 dev와 동일하게 유지되는지
    (BACKEND_TIMEOUT_SEC이 case 밖 공용 상수라 자동 충족되지만, 회귀 방지로 명시 검증)."""
    dev = _resolve(_PROVISION_GCLB, "dev")
    prod = _resolve(_PROVISION_GCLB, "prod")
    dev_timeout = dev["BACKEND_SERVICE_NAME"].split("timeout=")[1].split("s")[0]
    prod_timeout = prod["BACKEND_SERVICE_NAME"].split("timeout=")[1].split("s")[0]
    assert dev_timeout == prod_timeout == "3600"


def test_provision_gclb_dev_and_prod_are_separated():
    dev = _resolve(_PROVISION_GCLB, "dev")
    prod = _resolve(_PROVISION_GCLB, "prod")
    assert dev["MIG_NAME"] != prod["MIG_NAME"]
    assert dev["FW_RULE_NAME"] != prod["FW_RULE_NAME"]


def test_provision_gclb_invalid_env_rejected():
    proc = subprocess.run(
        ["bash", _PROVISION_GCLB, "staging"],
        capture_output=True, text=True,
        env={**os.environ, "DRY_RUN": "1"},
    )
    assert proc.returncode != 0
    assert "[dev|prod]" in proc.stderr
