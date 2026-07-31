"""story #2224 후속(오르테가 판정, 2026-07-31) — infra/check_env_drift.py 「환경별 브랜치
대조」 회귀가드. 배경: 스케줄 워크플로우가 main(default branch)만 checkout해 develop에만
있는 IaC/allowlist 수정(PR#2678)이 dev 서비스 대조에 영원히 반영 안 됐다(#2320/#2205와
같은 클래스 — 스케줄이 checkout하는 브랜치 ≠ 대조해야 할 정본). `_env_for_service`로
환경을 가르고 `--only-env`로 워크플로우가 브랜치별로 스크립트를 두 번 따로 부를 수 있게 한다.

gcloud 라이브 접근 없이(순수 정적 로직) 실행 가능.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_INFRA_DIR = _REPO_ROOT / "infra"


def _load_check_env_drift():
    spec = importlib.util.spec_from_file_location(
        "check_env_drift", _INFRA_DIR / "check_env_drift.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── _env_for_service — 명명 관례 둘 다 ───────────────────────────────────────

def test_env_for_service_master_services_explicit_suffix():
    """`_SERVICE_SCRIPT_MAP`(마스터) 7개 전부 "-dev"/"-prod" 접미사로 정확히 갈린다."""
    mod = _load_check_env_drift()
    expected = {
        "sprintable-backend-dev": "dev", "sprintable-backend-prod": "prod",
        "sprintable-frontend-dev": "dev", "sprintable-frontend-prod": "prod",
        "sprintable-mcp-dev": "dev", "sprintable-mcp-prod": "prod",
        "sprintable-realtime-dev": "dev",  # prod 짝 없음 — 그래도 접미사로 dev 판별.
    }
    for service, env in expected.items():
        assert mod._env_for_service(service) == env, service


def test_env_for_service_bare_name_is_prod_dev_suffix_pairs():
    """`excluded_services`류(별도 repo IaC 소관) — bare 이름=prod, "-dev"만 명시(sprintable-
    admin-web ↔ sprintable-admin-web-dev 실존 쌍, manual-env-allowlist.yml 참조)."""
    mod = _load_check_env_drift()
    assert mod._env_for_service("sprintable-admin-web") == "prod"
    assert mod._env_for_service("sprintable-admin-web-dev") == "dev"
    assert mod._env_for_service("sprintable-internal-api") == "prod"
    assert mod._env_for_service("sprintable-internal-api-dev") == "dev"


def test_env_for_service_never_raises_on_unknown_shape():
    """신규/미분류 이름도 크래시 없이 분류된다(접미사 없으면 prod로 — 별도 unmapped 처리는
    main() 루프의 ⑥축이 이미 담당, 이 함수는 크래시 대상이 아니다)."""
    mod = _load_check_env_drift()
    assert mod._env_for_service("some-brand-new-service") == "prod"


# ── main() 필터링 — only_env가 live_services를 정확히 좁힌다 ─────────────────

def test_main_only_env_filters_service_loop(monkeypatch):
    """`only_env`를 넘기면 그 환경 서비스만 루프에 들어간다 — 다른 환경 서비스는 아예 안
    보인다(라이브 gcloud 호출 없이, `_list_live_services`를 몽키패치해 순수 필터링만 검증)."""
    mod = _load_check_env_drift()

    seen_services: list[str] = []
    fake_services = [
        "sprintable-backend-dev", "sprintable-backend-prod",
        "sprintable-frontend-dev", "sprintable-frontend-prod",
    ]

    def _fake_list_live_services():
        return fake_services

    def _fake_live_env_entries(service):
        seen_services.append(service)
        return []

    monkeypatch.setattr(mod, "_list_live_services", _fake_list_live_services)
    monkeypatch.setattr(mod, "_live_env_entries", _fake_live_env_entries)
    monkeypatch.setattr(mod, "_load_allowlist", lambda: ({}, {}))
    monkeypatch.setattr(mod, "_iac_covered_keys", lambda: set())
    monkeypatch.setattr(mod, "_settings_field_env_keys", lambda: set())
    monkeypatch.setattr(mod, "_load_settings_exempt", lambda: [])
    monkeypatch.setattr(mod, "_web_env_reads", lambda: {})
    monkeypatch.setattr(mod, "_load_code_read_exempt", lambda: [])
    monkeypatch.setattr(mod, "_load_code_read_high_baseline", lambda: [])
    monkeypatch.setattr(mod, "_service_subset_wellformed_violations", lambda: [])
    monkeypatch.setattr(mod, "_external_iac_wellformed_violations", lambda: [])

    mod.main(only_env="dev")

    assert set(seen_services) == {"sprintable-backend-dev", "sprintable-frontend-dev"}


def test_main_no_only_env_processes_all_services(monkeypatch):
    """`only_env=None`(옛 동작·기본값)이면 전체 서비스를 그대로 본다 — 회귀 없음."""
    mod = _load_check_env_drift()

    seen_services: list[str] = []
    fake_services = [
        "sprintable-backend-dev", "sprintable-backend-prod",
        "sprintable-frontend-dev", "sprintable-frontend-prod",
    ]

    def _fake_list_live_services():
        return fake_services

    def _fake_live_env_entries(service):
        seen_services.append(service)
        return []

    monkeypatch.setattr(mod, "_list_live_services", _fake_list_live_services)
    monkeypatch.setattr(mod, "_live_env_entries", _fake_live_env_entries)
    monkeypatch.setattr(mod, "_load_allowlist", lambda: ({}, {}))
    monkeypatch.setattr(mod, "_iac_covered_keys", lambda: set())
    monkeypatch.setattr(mod, "_settings_field_env_keys", lambda: set())
    monkeypatch.setattr(mod, "_load_settings_exempt", lambda: [])
    monkeypatch.setattr(mod, "_web_env_reads", lambda: {})
    monkeypatch.setattr(mod, "_load_code_read_exempt", lambda: [])
    monkeypatch.setattr(mod, "_load_code_read_high_baseline", lambda: [])
    monkeypatch.setattr(mod, "_service_subset_wellformed_violations", lambda: [])
    monkeypatch.setattr(mod, "_external_iac_wellformed_violations", lambda: [])

    mod.main()

    assert set(seen_services) == set(fake_services)


# ── --only-env CLI 파싱 ──────────────────────────────────────────────────────

def test_parse_only_env_absent_returns_none():
    mod = _load_check_env_drift()
    assert mod._parse_only_env([]) is None


def test_parse_only_env_valid_values():
    mod = _load_check_env_drift()
    assert mod._parse_only_env(["--only-env", "dev"]) == "dev"
    assert mod._parse_only_env(["--only-env", "prod"]) == "prod"


def test_parse_only_env_invalid_value_exits():
    mod = _load_check_env_drift()
    with pytest.raises(SystemExit):
        mod._parse_only_env(["--only-env", "staging"])


def test_parse_only_env_missing_value_exits():
    mod = _load_check_env_drift()
    with pytest.raises(SystemExit):
        mod._parse_only_env(["--only-env"])
