"""story #f6d1bbaa — check_stamp_chain_integrity.py 양성/음성대조(실 PG).

페드루 요구사항: 「이번 사고 상태(0228~ 미실행+마커 전진)를 그대로 먹이면 빨강이
떠야 가드가 실재하는 것」. 이 테스트는 #70bc4bc3 실사고를 정확히 재현하는 DB를
만들어(0227까지 정상 적용 → 0236/0240/0243만 직접 실행 후 stamp, 실 로그가 보여준
순서 그대로) 가드를 돌린다.

`PARITY_TEST_DATABASE_URL`/`ALEMBIC_DATABASE_URL` 미설정 시 skip(다른 realdb 테스트와
동일 컨벤션). destructive_schema 마커로 conftest의 auto-reset 픽스처를 탄다."""
from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest
from alembic.runtime.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
pytestmark = pytest.mark.skipif(not _REAL_DB_URL, reason="PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL 미설정")

_BACKEND_DIR = Path(__file__).parent.parent
_VERSIONS_DIR = _BACKEND_DIR / "alembic" / "versions"
_GUARD_SCRIPT = _BACKEND_DIR / "scripts" / "jobs" / "check_stamp_chain_integrity.py"


def _apply_upgrade_directly(url: str, filename_prefix: str) -> None:
    """지정 접두사로 시작하는 리비전 파일 하나를 alembic 체인과 무관하게 직접
    upgrade()만 실행(#70bc4bc3 재봉합 사고 재현용 — 특정 리비전만 골라 물리 적용)."""
    matches = list(_VERSIONS_DIR.glob(f"{filename_prefix}*.py"))
    assert len(matches) == 1, f"{filename_prefix}: {len(matches)}개 매치(1개여야 함)"
    engine = create_engine(url)
    with engine.connect() as conn:
        ctx = MigrationContext.configure(conn)
        op_obj = Operations(ctx)
        import alembic.op as op_module
        op_module._proxy = op_obj
        spec = importlib.util.spec_from_file_location("m", str(matches[0]))
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        m.upgrade()
        conn.commit()
    engine.dispose()


def _run_alembic(url: str, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "ALEMBIC_DATABASE_URL": url}
    return subprocess.run(
        ["uv", "run", "alembic", *args], cwd=_BACKEND_DIR, env=env,
        capture_output=True, text=True,
    )


def _run_guard(url: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "ALEMBIC_DATABASE_URL": url}
    return subprocess.run(
        [sys.executable, str(_GUARD_SCRIPT)], cwd=_BACKEND_DIR, env=env,
        capture_output=True, text=True,
    )


@pytest.mark.destructive_schema
def test_positive_control_incident_state_is_red():
    """#70bc4bc3 실사고 그대로 재현 — 0227까지 정상, 이후 0236/0240/0243만 직접
    실행+stamp(재봉합 이미지 그대로), 나머지는 정상 upgrade. 가드는 반드시 FAIL(exit 1)."""
    url = _REAL_DB_URL
    r = _run_alembic(url, "upgrade", "0227")
    assert r.returncode == 0, r.stderr

    _apply_upgrade_directly(url, "0236_")
    _apply_upgrade_directly(url, "0240_")
    _apply_upgrade_directly(url, "0241_")
    _apply_upgrade_directly(url, "0243_")

    r = _run_alembic(url, "stamp", "0243")
    assert r.returncode == 0, r.stderr
    r = _run_alembic(url, "upgrade", "head")
    assert r.returncode == 0, r.stderr

    guard = _run_guard(url)
    assert guard.returncode == 1, f"양성대조 실패 — 가드가 이상상태를 못 잡음:\n{guard.stdout}\n{guard.stderr}"
    assert "offering_versions" in guard.stderr
    assert "hypotheses.superseded_by_hypothesis_id" in guard.stderr


@pytest.mark.destructive_schema
def test_negative_control_normal_full_chain_is_green():
    """정상 dev 시나리오 — 전체 체인 순차 적용(스킵 없음). 가드는 반드시 PASS(exit 0)."""
    url = _REAL_DB_URL
    r = _run_alembic(url, "upgrade", "head")
    assert r.returncode == 0, r.stderr

    guard = _run_guard(url)
    assert guard.returncode == 0, f"음성대조 실패 — 정상 DB인데 가드가 오탐:\n{guard.stdout}\n{guard.stderr}"
