"""story #4022(prod 승격 준비) — `cloudbuild.yaml` SECRETS_FLAG dev 갈래엔 있는데 prod 갈래에
빠진 채널 시크릿 2개(CHANNEL_CREDENTIAL_ENCRYPTION_KEY/CHANNEL_OAUTH_STATE_SECRET)를 발견한
계기로, dev↔prod ENV 키 대칭을 상시 대조하는 PR 게이트 가드.

`test_3140_cloudbuild_secret_manifest_guard.py`(VALUE=GCP 시크릿 리소스명 존재 축)와 자매
스위트 — 이쪽은 KEY(컨테이너 ENV 이름) 대칭 축. gcloud/GCP 인증 불요(순수 텍스트 대조).

AC2(양성대조) — prod 갈래에서 한 줄(키)을 지우면 이 스위트가 실제로 red가 되는지가 핵심 표본."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "infra"))

import check_secrets_flag_env_symmetry as sym_gate  # noqa: E402


_SAMPLE_CLOUDBUILD = '''
        SECRETS_FLAG=""
        if [ "${_DEPLOY_ENV}" == "dev" ]; then
          SECRETS_FLAG="--update-secrets=DATABASE_URL=DATABASE_URL_DEV_PGBOUNCER_SPRINTABLE:latest,DATABASE_URL_DIRECT=DATABASE_URL_DIRECT_DEV_SPRINTABLE:latest,APPLE_PRIVATE_KEY=APPLE_SIWA_PRIVATE_KEY:latest,SUPPORT_GATEWAY_TOKEN_SECRET=SUPPORT_GATEWAY_TOKEN_SECRET_dev:latest,CHANNEL_CREDENTIAL_ENCRYPTION_KEY=CHANNEL_CREDENTIAL_ENCRYPTION_KEY_DEV:latest,CHANNEL_OAUTH_STATE_SECRET=CHANNEL_OAUTH_STATE_SECRET_DEV:latest"
        elif [ "${_DEPLOY_ENV}" == "prod" ]; then
          SECRETS_FLAG="--update-secrets=DATABASE_URL=DATABASE_URL_PROD_PGBOUNCER:latest,DATABASE_URL_DIRECT=DATABASE_URL_PROD:latest,DATABASE_URL_READ=DATABASE_URL_READ:latest,APPLE_PRIVATE_KEY=APPLE_SIWA_PRIVATE_KEY:latest,CHANNEL_CREDENTIAL_ENCRYPTION_KEY=CHANNEL_CREDENTIAL_ENCRYPTION_KEY_PROD:latest,CHANNEL_OAUTH_STATE_SECRET=CHANNEL_OAUTH_STATE_SECRET_PROD:latest"
        fi
'''


def test_extract_secrets_flag_keys_parses_dev_and_prod_branches():
    dev_keys, prod_keys = sym_gate.extract_secrets_flag_keys(_SAMPLE_CLOUDBUILD)
    assert dev_keys == {
        "DATABASE_URL", "DATABASE_URL_DIRECT", "APPLE_PRIVATE_KEY",
        "SUPPORT_GATEWAY_TOKEN_SECRET", "CHANNEL_CREDENTIAL_ENCRYPTION_KEY",
        "CHANNEL_OAUTH_STATE_SECRET",
    }
    assert prod_keys == {
        "DATABASE_URL", "DATABASE_URL_DIRECT", "DATABASE_URL_READ", "APPLE_PRIVATE_KEY",
        "CHANNEL_CREDENTIAL_ENCRYPTION_KEY", "CHANNEL_OAUTH_STATE_SECRET",
    }


def test_extract_secrets_flag_keys_missing_block_raises_not_silent_empty():
    import pytest
    with pytest.raises(RuntimeError, match="SECRETS_FLAG"):
        sym_gate.extract_secrets_flag_keys("no such block here")


def test_check_passes_when_symmetric_modulo_known_exceptions():
    dev_keys, prod_keys = sym_gate.extract_secrets_flag_keys(_SAMPLE_CLOUDBUILD)
    ok, lines = sym_gate.check(dev_keys, prod_keys)
    assert ok, lines


def test_check_flags_dev_only_key_without_exception():
    ok, lines = sym_gate.check(
        dev_keys={"DATABASE_URL", "SOME_NEW_DEV_KEY"}, prod_keys={"DATABASE_URL"},
    )
    assert ok is False
    assert any("SOME_NEW_DEV_KEY" in line for line in lines)


def test_check_flags_prod_only_key_without_exception():
    ok, lines = sym_gate.check(
        dev_keys={"DATABASE_URL"}, prod_keys={"DATABASE_URL", "SOME_NEW_PROD_KEY"},
    )
    assert ok is False
    assert any("SOME_NEW_PROD_KEY" in line for line in lines)


def test_check_allows_documented_dev_only_exception():
    ok, lines = sym_gate.check(
        dev_keys={"DATABASE_URL", "SUPPORT_GATEWAY_TOKEN_SECRET"}, prod_keys={"DATABASE_URL"},
    )
    assert ok, lines


def test_check_allows_documented_prod_only_exception():
    ok, lines = sym_gate.check(
        dev_keys={"DATABASE_URL"}, prod_keys={"DATABASE_URL", "DATABASE_URL_READ"},
    )
    assert ok, lines


def test_ac2_positive_control_removing_prod_channel_key_goes_red():
    """AC2 핵심 표본 — 이 카드가 고치는 실제 버그(채널 시크릿 2개가 prod에서 빠짐)를 그대로
    재현: prod 갈래에서 CHANNEL_OAUTH_STATE_SECRET 한 줄(키)을 지우면 반드시 red."""
    dev_keys, prod_keys = sym_gate.extract_secrets_flag_keys(_SAMPLE_CLOUDBUILD)
    mutated_prod = prod_keys - {"CHANNEL_OAUTH_STATE_SECRET"}
    ok, lines = sym_gate.check(dev_keys, mutated_prod)
    assert ok is False, "prod에서 채널 시크릿 키 한 줄이 빠졌는데도 가드가 green — AC2 위반"
    assert any("CHANNEL_OAUTH_STATE_SECRET" in line for line in lines)


def test_real_repo_cloudbuild_secrets_flag_dev_prod_symmetric():
    """실 레포 `cloudbuild.yaml`을 대상으로 한 핀 테스트 — story #4022 AC1 반영 후 지금 시점
    dev/prod SECRETS_FLAG ENV 키가 예외 목록 대비 대칭임을 고정한다."""
    ok, lines = sym_gate.check()
    assert ok, f"실 cloudbuild.yaml SECRETS_FLAG dev/prod ENV 키 비대칭: {lines}"


def test_ac2_positive_control_real_cloudbuild_prod_channel_key_removed_goes_red():
    """AC2(PO CHANGES 2 지적 — 합성 텍스트 대조만으론 «못 틀리는 대조» 보장이 안 됨) — 실제
    `cloudbuild.yaml` 파일 텍스트에서 직접 prod 채널 시크릿 조각을 지워 RED를 확인한다.
    지우기 전 조각이 실 파일에 있다는 것도 먼저 단언(조각이 애초에 없으면 이 대조 자체가
    무의미해지는 것을 방지)."""
    real_text = sym_gate._CLOUDBUILD_YAML.read_text()
    needle = ",CHANNEL_OAUTH_STATE_SECRET=CHANNEL_OAUTH_STATE_SECRET_PROD:latest"
    assert needle in real_text, "지우기 전 조각이 실 파일에 없음 — 이 대조 자체가 무의미해짐"
    mutated_text = real_text.replace(needle, "", 1)
    assert needle not in mutated_text

    dev_keys, prod_keys = sym_gate.extract_secrets_flag_keys(mutated_text)
    ok, lines = sym_gate.check(dev_keys, prod_keys)
    assert ok is False, "실 cloudbuild.yaml에서 prod 채널 키 한 줄을 지웠는데도 가드가 green — AC2 위반"
    assert any("CHANNEL_OAUTH_STATE_SECRET" in line for line in lines)
