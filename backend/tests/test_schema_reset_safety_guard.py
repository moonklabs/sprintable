"""story 9108cb4f 안전가드 테스트 — DROP SCHEMA 자기청소가 dev/prod DB를 절대 건드리지 않는지.

⛔ 이 가드가 없으면 스키마 리셋 fixture 자체가 사고 무기(오배치 시 실 DB 전소). 까심 QA 핵심:
dev/prod URL이 확실히 거부되고, 테스트 DB만 허용되는지. realdb 불요(순수 로직 단위 테스트)."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from conftest import assert_disposable_test_db  # noqa: E402


@pytest.mark.parametrize("url", [
    "postgresql+psycopg2://u@localhost:5432/steer_test2",
    "postgresql+psycopg2://u@localhost:5432/backend_parity",
    "postgresql+asyncpg://u@localhost:5432/ci_scratch",
    "postgresql://u@localhost:5432/ephemeral_1234",
])
def test_allows_disposable_test_dbs(url):
    """테스트 신호(test/parity/ci/ephemeral) 있는 DB는 허용(예외 없음)."""
    assert_disposable_test_db(url)  # should not raise


@pytest.mark.parametrize("url", [
    "postgresql+psycopg2://u@/cloudsql/moonklabs:asia:sprintable-prod/sprintable",
    "postgresql+psycopg2://u@10.0.0.5:5432/sprintable-dev",
    "postgresql+psycopg2://u@host:5432/production",
    "postgresql+psycopg2://u@host:5432/sprintable_prod",
])
def test_rejects_dev_prod_dbs(url):
    """⛔ dev/prod 마커 DB는 무조건 거부(RuntimeError·파괴 DDL 미실행)."""
    with pytest.raises(RuntimeError, match="안전가드"):
        assert_disposable_test_db(url)


@pytest.mark.parametrize("url", [
    "postgresql+psycopg2://u@host:5432/randomname",
    "postgresql+psycopg2://u@host:5432/app_main",
    "postgresql+psycopg2://u@host:5432/customer_data",
])
def test_rejects_unrecognized_dbs_without_optin(url):
    """테스트 신호도 opt-in flag도 없는 DB는 거부(fail-safe·모르는 DB는 안 건드림)."""
    with pytest.raises(RuntimeError, match="안전가드"):
        assert_disposable_test_db(url)


@pytest.mark.parametrize("url", [
    # 까심 QA(#2095 RC) fail-open 회귀 방지: "test"/"latest"가 다른 단어 안에 우연히 포함된 실 DB
    # 이름 — substring 매치면 통과했으나 토큰 경계 매치로 반드시 거부(dev/prod 마커도 없어 deny-list
    # 도 안 걸리는 "모르는 DB"라 파괴 DDL 절대 불가).
    "postgresql+psycopg2://u@host:5432/customer_data_latest",
    "postgresql+psycopg2://u@host:5432/contest_entries",
    "postgresql+psycopg2://u@host:5432/protest_data",
    "postgresql+psycopg2://u@host:5432/orders_latest_snapshot",
    "postgresql+psycopg2://u@host:5432/precision_analytics",
    "postgresql+psycopg2://u@host:5432/municipal_records",
])
def test_rejects_substring_fail_open_names(url):
    """substring fail-open 봉인: 'test'가 latest/contest/protest 안에 우연히 들어도 토큰 경계가
    아니면 테스트 신호로 불인정 → 거부(까심 적출 catastrophic fail-open)."""
    with pytest.raises(RuntimeError, match="안전가드"):
        assert_disposable_test_db(url)


@pytest.mark.parametrize("url", [
    # CI 실 DB명은 반드시 허용돼야 한다(과잉거부 회귀 방지 — 토큰 경계로 test 온전 포함).
    "postgresql+psycopg2://sprintable:sprintable@localhost:5432/sprintable_test",
    "postgresql+psycopg2://sprintable:sprintable@localhost:5432/sprintable_test_iso",
])
def test_allows_ci_db_names(url):
    """CI가 쓰는 sprintable_test / sprintable_test_iso는 test 온전 토큰이라 허용(guard가 CI를 막지 않음)."""
    assert_disposable_test_db(url)


def test_optin_flag_allows_unrecognized(monkeypatch):
    """명시 opt-in(ALLOW_DESTRUCTIVE_SCHEMA_RESET=1)이면 테스트-신호 없는 이름도 허용 —
    단 prod/dev 마커는 flag가 있어도 여전히 거부(deny-list 우선)."""
    monkeypatch.setenv("ALLOW_DESTRUCTIVE_SCHEMA_RESET", "1")
    assert_disposable_test_db("postgresql+psycopg2://u@host:5432/randomname")  # ok with flag
    with pytest.raises(RuntimeError, match="안전가드"):
        assert_disposable_test_db("postgresql+psycopg2://u@host:5432/sprintable-prod")  # deny-list 우선
