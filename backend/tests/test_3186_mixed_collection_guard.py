"""story #3186 — conftest.py 「혼합 수집 차단」 가드 양성대조.

배경(2026-08-28, 카디르 QA·실사고 그라운딩): 스토리 원 전제("공유 seed 헬퍼가 NOT NULL
컬럼을 못 채운다")는 실측으로 반증됐다 — organizations.plan은 DB server_default='free'가
실존해(psql \\d로 직접 확認) seed 누락이 애초에 문제가 안 된다. 진짜 원인은
conftest.py::_reset_schema_for_destructive_tests(autouse) — destructive_schema 마커
테스트 실행 直前 `DROP SCHEMA public CASCADE`로 전체 스키마를 지우고 재마이그레이션 없이
둔다(그 테스트 자신이 파일 안에서 스스로 create_all/drop_all 하는 걸 전제). 이게
non-destructive 테스트와 **같은 세션**에 섞여 수집되면, destructive 항목 하나가 실행된
뒤로 나머지 전부가 "relation ... does not exist"로 연쇄 FAIL한다.

실측 대조(로컬 disposable PG, alembic upgrade heads):
- `pytest -k realdb`(마커 무시, 광범위 selector) → 1058 FAIL.
- `pytest -k realdb -m "not destructive_schema"`(CI "Backend pytest"가 실제로 쓰는 정확한
  필터) → 1837 PASSED · 0 FAIL.
이 대조가 AC2("왜 CI green이었나")의 답이다 — CI는 애초에 두 축을 절대 안 섞는다(Backend
pytest=`-m "not destructive_schema"`·backend-test-destructive=파일별 격리 신선 DB).

처방(PO 확定 2026-08-28) — README 경고문(안 읽은 사람을 못 막는다)도 자동 재마이그레이션
(«지원할 이유 없는 실행 모드»를 비싸게 지원하는 과투자)도 아니라, 지원 안 하는 모드 자체를
collection 시점에 즉시 거부한다(조용한 대량 오염 → 시끄러운 즉시 실패). 이 파일은 그
처방(conftest.py::pytest_collection_modifyitems 확장분)이 실제로 작동하는지 실 pytest
서브프로세스로 검증한다(test_2643_destructive_schema_ddl_guard.py와 동일 subprocess+
tmp_path 관례).
"""
from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path


def _copy_conftest(tmp_path: Path) -> None:
    conftest_src = (Path(__file__).parent / "conftest.py").read_text(encoding="utf-8")
    (tmp_path / "conftest.py").write_text(conftest_src, encoding="utf-8")


_DESTRUCTIVE_VICTIM = """
    import pytest
    from sqlalchemy import text

    pytestmark = pytest.mark.destructive_schema

    def test_wipes_schema(x_conn):
        x_conn.execute(text("DROP TABLE IF EXISTS foo"))
"""

_NON_DESTRUCTIVE_VICTIM = """
    def test_ordinary():
        assert 1 + 1 == 2
"""


def test_positive_control_mixed_collection_rejected_at_collect_time(tmp_path: Path):
    """AC — destructive_schema 마커 파일과 non-destructive 파일이 같은 세션에 함께
    수집되면 즉시 UsageError(exit code 4)로 죽는지 실측(story #3186 실사고 재현)."""
    (tmp_path / "test_3186_destructive_victim.py").write_text(textwrap.dedent(_DESTRUCTIVE_VICTIM))
    (tmp_path / "test_3186_ordinary_victim.py").write_text(textwrap.dedent(_NON_DESTRUCTIVE_VICTIM))
    _copy_conftest(tmp_path)

    result = subprocess.run(
        [sys.executable, "-m", "pytest", str(tmp_path), "--collect-only", "-q"],
        capture_output=True, text=True, cwd=tmp_path,
    )
    combined = result.stdout + result.stderr
    assert result.returncode == 4, f"stdout={result.stdout}\nstderr={result.stderr}"
    assert "같은 세션에 함께 수집됐습니다" in combined
    assert "not destructive_schema" in combined
    assert "test_3186_destructive_victim.py" in combined


def test_positive_control_marker_filter_excludes_destructive_and_passes(tmp_path: Path):
    """처방 그 자체의 유효성 — `-m "not destructive_schema"`(CI가 실제로 쓰는 필터)를
    같은 두 파일에 걸면 destructive 파일이 디셀렉트되어 혼합이 사라지고 정상 통과한다
    (trylast=True 배선이 -k/-m 디셀렉션 *이후*에 items를 보는지까지 함께 고정 —
    이게 없으면 필터를 걸어도 여전히 필터 前 스냅샷을 보고 오탐 차단된다, 실사고 2회차)."""
    (tmp_path / "test_3186_destructive_victim.py").write_text(textwrap.dedent(_DESTRUCTIVE_VICTIM))
    (tmp_path / "test_3186_ordinary_victim.py").write_text(textwrap.dedent(_NON_DESTRUCTIVE_VICTIM))
    _copy_conftest(tmp_path)

    result = subprocess.run(
        [sys.executable, "-m", "pytest", str(tmp_path), "-m", "not destructive_schema", "--collect-only", "-q"],
        capture_output=True, text=True, cwd=tmp_path,
    )
    assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"


def test_positive_control_destructive_only_selection_passes(tmp_path: Path):
    """destructive만 골라 돌리는 것(CI backend-test-destructive의 파일별 격리 순회와 동형
    선택)도 혼합이 아니므로 정상 통과 — 이 가드가 destructive 자체를 막는 게 아니라
    «섞임»만 막는다는 것을 함께 고정."""
    (tmp_path / "test_3186_destructive_victim.py").write_text(textwrap.dedent(_DESTRUCTIVE_VICTIM))
    (tmp_path / "test_3186_ordinary_victim.py").write_text(textwrap.dedent(_NON_DESTRUCTIVE_VICTIM))
    _copy_conftest(tmp_path)

    result = subprocess.run(
        [sys.executable, "-m", "pytest", str(tmp_path), "-m", "destructive_schema", "--collect-only", "-q"],
        capture_output=True, text=True, cwd=tmp_path,
    )
    assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"


def test_no_regression_single_kind_directories_still_collect_fine(tmp_path: Path):
    """회귀가드 — non-destructive 파일 «하나만» 있는 흔한 경우(이 조직 실 tests/ 스위트
    대부분)는 기존처럼 아무 방해 없이 수집된다."""
    (tmp_path / "test_3186_only_ordinary.py").write_text(textwrap.dedent(_NON_DESTRUCTIVE_VICTIM))
    _copy_conftest(tmp_path)

    result = subprocess.run(
        [sys.executable, "-m", "pytest", str(tmp_path), "--collect-only", "-q"],
        capture_output=True, text=True, cwd=tmp_path,
    )
    assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"
