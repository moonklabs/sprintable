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


def test_deploy_gce_github_app_identity_matches_live_cloud_run_binding():
    """story #2142(오르테가 DRY_RUN 검수 적발, 2026-07-23) — GITHUB_APP_ID/CLIENT_ID/SLUG가
    env 분기 밖 리터럴(dev App 값)로 박혀 있어, prod 플랜이 dev App의 ID/CLIENT_ID와
    prod 전용 시크릿(github-app-*-prod)을 섞은 채 배포될 뻔했다(둘 다 값의 유무와 무관하게
    같은 App 소속이어야 인증이 성립 — 섞이면 어느 쪽으로도 인증 불가). backend-prod
    gcloud describe 라이브 실측으로 prod 분기를 교정 — dev는 무회귀."""
    dev = _resolve(_DEPLOY_GCE, "dev")
    prod = _resolve(_DEPLOY_GCE, "prod")
    assert "GITHUB_APP_ID=4120278" in dev["PLAIN_ENV_SPEC"]
    assert "GITHUB_APP_CLIENT_ID=Iv23liRkrmyqoCZIlrgh" in dev["PLAIN_ENV_SPEC"]
    assert "GITHUB_APP_SLUG=sprintable-dev" in dev["PLAIN_ENV_SPEC"]
    assert "GITHUB_APP_ID=4244849" in prod["PLAIN_ENV_SPEC"]
    assert "GITHUB_APP_CLIENT_ID=Iv23liGdo7u9vkHjRKS0" in prod["PLAIN_ENV_SPEC"]
    assert "GITHUB_APP_SLUG=sprintable-prod" in prod["PLAIN_ENV_SPEC"]
    # 섞임 재발 차단 — prod 플랜에 dev App 식별자가 전혀 없어야 한다.
    assert "4120278" not in prod["PLAIN_ENV_SPEC"]
    assert "Iv23liRkrmyqoCZIlrgh" not in prod["PLAIN_ENV_SPEC"]
    assert "sprintable-dev" not in prod["PLAIN_ENV_SPEC"]


def test_deploy_gce_dev_only_gate_features_absent_from_prod():
    """story #2142(오르테가 DRY_RUN 검수 3번째 적발, 2026-07-23) — 같은 뿌리
    ("dev 라이브 관측 사실을 env 분기 없이 prod에 적용"), 셋 중 가장 큰 건. L2_TRIGGER_*/
    GATE_CONFIG_ENFORCE_*/DECISION_GATE_LINE_*는 backend-prod에 키 자체가 없다(그 기능이
    prod에서 한 번도 켜진 적 없음, describe 대조 확認) — env 분기 밖 리터럴이라 prod 플랜에
    dev 전용 org 허용목록을 단 채 그대로 켜질 뻔했다. 이 GCE 노드가 backend와 동일 이미지라
    플래그가 켜지면 실제로 그 lifespan 워커가 뜬다(추론 아니라 미러링으로 처리 — 오르테가
    판정). prod는 이 3그룹을 아예 안 붙인다."""
    prod = _resolve(_DEPLOY_GCE, "prod")
    for key in ("L2_TRIGGER_ENABLED", "L2_TRIGGER_ADVISORY_LOCK", "L2_TRIGGER_ORG_ALLOWLIST",
                "L2_TRIGGER_MAX_WAKES_PER_ORG_PER_HOUR", "GATE_CONFIG_ENFORCE_ENABLED",
                "GATE_CONFIG_ENFORCE_ORG_ALLOWLIST", "DECISION_GATE_LINE_ENABLED",
                "DECISION_GATE_LINE_ORG_ALLOWLIST", "DECISION_GATE_LINE_MODE"):
        assert key not in prod["PLAIN_ENV_SPEC"], f"{key}가 prod 플랜에 실리면 안 됨"


def test_deploy_gce_dev_gate_features_unchanged():
    """dev는 이 4그룹(L2_TRIGGER/H1_MERGE_GATE/GATE_CONFIG_ENFORCE/DECISION_GATE_LINE) 전부
    현행 그대로 — 무회귀."""
    dev = _resolve(_DEPLOY_GCE, "dev")
    assert "L2_TRIGGER_ENABLED=true" in dev["PLAIN_ENV_SPEC"]
    assert "L2_TRIGGER_ORG_ALLOWLIST=54bac162-5c0d-49fa-8e49-85977063a091" in dev["PLAIN_ENV_SPEC"]
    assert "GATE_CONFIG_ENFORCE_ENABLED=true" in dev["PLAIN_ENV_SPEC"]
    assert "DECISION_GATE_LINE_ENABLED=true" in dev["PLAIN_ENV_SPEC"]
    assert "H1_MERGE_GATE_ORG_ALLOWLIST=54bac162-5c0d-49fa-8e49-85977063a091" in dev["PLAIN_ENV_SPEC"]
    # dev의 H1 허용목록은 단일 org — prod의 2-org 값이 섞여 들어가면 안 됨.
    assert "588186bf-1558-48a3-b3a0-fe3759a925fc" not in dev["PLAIN_ENV_SPEC"]


def test_deploy_gce_prod_h1_merge_gate_matches_live_two_org_allowlist():
    """story #2142(오르테가 gcloud 실측, 2026-07-23) — H1_MERGE_GATE는 backend-prod에도
    실재(ENABLED/ADVISORY=true/true, dev와 동일)하지만 허용목록은 dev 단일 org가 아니라
    prod의 실제 2-org 콤마리스트다(describe 대조 확認). prod 플랜이 dev 값을 쓰면 실제
    prod 허용 조직 중 하나(588186bf-...)가 빠지는 것과 같아 라이브과 어긋난다."""
    prod = _resolve(_DEPLOY_GCE, "prod")
    assert "H1_MERGE_GATE_ENABLED=true" in prod["PLAIN_ENV_SPEC"]
    assert "H1_MERGE_GATE_ADVISORY=true" in prod["PLAIN_ENV_SPEC"]
    assert (
        "H1_MERGE_GATE_ORG_ALLOWLIST=54bac162-5c0d-49fa-8e49-85977063a091,"
        "588186bf-1558-48a3-b3a0-fe3759a925fc"
    ) in prod["PLAIN_ENV_SPEC"]


def test_deploy_gce_db_self_name_binding_dev_only():
    """story #2142(오르테가 DRY_RUN 검수 적발, 2026-07-23) — GitHub App 건과 동일 클래스
    ("dev 라이브에서 관측한 사실을 env 분기 없이 prod에 적용"). ${DB_SECRET_NAME}:
    ${DB_SECRET_NAME} 자기이름 바인딩이 env 분기 밖이라 prod 플랜에도 DATABASE_URL_PROD:
    DATABASE_URL_PROD로 그대로 실렸다 — 라이브 대조 결과 이 계약은 backend-dev에만
    실재(DATABASE_URL_PROD 키는 backend-prod에 아예 없고 코드도 안 읽음). prod에 DB 접속
    문자열(비밀번호 포함)을 이름만 추가해 한 벌 더 싣는 불필요한 자격증명 표면 확장 — dev만
    유지, prod는 붙이지 않는다."""
    dev = _resolve(_DEPLOY_GCE, "dev")
    prod = _resolve(_DEPLOY_GCE, "prod")
    assert "DATABASE_URL_DEV:DATABASE_URL_DEV" in dev["SECRET_PAIRS"]
    assert "DATABASE_URL_PROD:DATABASE_URL_PROD" not in prod["SECRET_PAIRS"]


def test_deploy_gce_prod_secret_pairs_no_dev_leak():
    """story #2142 회귀 방지 — DB_SECRET_NAME 미사용으로 prod 플랜에 dev 시크릿이
    하드코딩 리터럴로 섞여 들어가던 결함(발견 즉시 수정)의 재발 차단.

    ⚠️GITHUB_CLIENT_ID_DEV/GITHUB_CLIENT_SECRET_DEV는 예외 — backend-prod Cloud Run이
    실제로 그 시크릿을 쓰는 것을 오르테가 gcloud 실측으로 확認(2026-07-23, 유저 로그인
    OAuth 앱이 아직 prod 전용이 아님, GitHub App 봇과는 별개 물건). 아래
    `test_deploy_gce_prod_github_oauth_client_matches_live_cloud_run_binding`가 그 의도적
    매핑을 별도로 고정한다 — 여기선 DATABASE_URL_DEV(진짜 리크였던 것)만 확인."""
    cfg = _resolve(_DEPLOY_GCE, "prod")
    assert "DATABASE_URL_DEV" not in cfg["SECRET_PAIRS"]
    assert "GITHUB_CLIENT_ID_DEV:GITHUB_CLIENT_ID" in cfg["SECRET_PAIRS"]
    assert "GITHUB_CLIENT_SECRET_DEV:GITHUB_CLIENT_SECRET" in cfg["SECRET_PAIRS"]


def test_deploy_gce_prod_github_oauth_client_matches_live_cloud_run_binding():
    """story #2142(오르테가 gcloud 실측, 2026-07-23) — GITHUB_CLIENT_ID_PROD/
    GITHUB_CLIENT_SECRET_PROD는 Secret Manager에 존재하지 않는다. backend-prod Cloud Run이
    실제로 물고 있는 시크릿은 GITHUB_CLIENT_ID_DEV/GITHUB_CLIENT_SECRET_DEV(describe로 대조
    확認) — 새 시크릿을 만드는 게 아니라 GCE도 Cloud Run과 같은 것을 물게 한다(스코프 확定,
    적절성 판단은 별건)."""
    cfg = _resolve(_DEPLOY_GCE, "prod")
    assert "GITHUB_CLIENT_ID_PROD" not in cfg["SECRET_PAIRS"]
    assert "GITHUB_CLIENT_SECRET_PROD" not in cfg["SECRET_PAIRS"]


def test_deploy_gce_prod_cron_secret_matches_live_cloud_run_binding():
    """story #2142(오르테가 gcloud 실측, 2026-07-23) — backend-prod Cloud Run은 CRON_SECRET을
    `cron-secret`(dev가 쓰는 이름)이 아니라 `CRON_SECRET_PROD`에서 fetch한다. 이전엔 env
    분기 없이 `cron-secret:CRON_SECRET`이 dev/prod 공용이라 존재는 해도 다른 값이 실렸다."""
    prod = _resolve(_DEPLOY_GCE, "prod")
    dev = _resolve(_DEPLOY_GCE, "dev")
    assert "CRON_SECRET_PROD:CRON_SECRET" in prod["SECRET_PAIRS"]
    assert "cron-secret:CRON_SECRET" in dev["SECRET_PAIRS"]


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


def test_deploy_gce_prod_redis_url_via_secret_not_plaintext():
    """story #2142 후속 발견(오르테가 지시, 2026-07-23) — prod AUTH 있는 Redis URL이
    PLAIN_ENV_SPEC 평문으로 인스턴스 메타데이터에 박히면 안 되고 SECRET_PAIRS로만 가야 한다."""
    cfg = _resolve(_DEPLOY_GCE, "prod")
    assert "REDIS_URL_PROD:REDIS_URL" in cfg["SECRET_PAIRS"]
    assert "REDIS_URL=" not in cfg["PLAIN_ENV_SPEC"]


def test_deploy_gce_dev_redis_url_plaintext_unchanged():
    """dev: AUTH 없는 plain Memorystore IP 리터럴 — 이번 변경으로 한 글자도 안 바뀌어야 한다."""
    cfg = _resolve(_DEPLOY_GCE, "dev")
    assert "REDIS_URL=redis://10.164.120.243:6379" in cfg["PLAIN_ENV_SPEC"]
    assert "REDIS_URL" not in cfg["SECRET_PAIRS"]


def test_deploy_gce_prod_redis_url_env_override_ignored_for_secret_routing():
    """prod는 REDIS_URL 환경변수를 넘겨도(과거 실수 방지 목적) 여전히 시크릿 경로로만
    가야 한다 — 평문 우회 통로가 생기면 안 된다."""
    cfg = _resolve(_DEPLOY_GCE, "prod", extra={"REDIS_URL": "redis://leaked:leaked@1.2.3.4:6379"})
    assert "REDIS_URL_PROD:REDIS_URL" in cfg["SECRET_PAIRS"]
    assert "REDIS_URL=" not in cfg["PLAIN_ENV_SPEC"]
    assert "leaked" not in cfg["PLAIN_ENV_SPEC"]


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
