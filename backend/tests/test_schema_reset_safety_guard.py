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


def test_optin_flag_allows_unrecognized(monkeypatch):
    """명시 opt-in(ALLOW_DESTRUCTIVE_SCHEMA_RESET=1)이면 테스트-신호 없는 이름도 허용 —
    단 prod/dev 마커는 flag가 있어도 여전히 거부(deny-list 우선)."""
    monkeypatch.setenv("ALLOW_DESTRUCTIVE_SCHEMA_RESET", "1")
    assert_disposable_test_db("postgresql+psycopg2://u@host:5432/randomname")  # ok with flag
    with pytest.raises(RuntimeError, match="안전가드"):
        assert_disposable_test_db("postgresql+psycopg2://u@host:5432/sprintable-prod")  # deny-list 우선
