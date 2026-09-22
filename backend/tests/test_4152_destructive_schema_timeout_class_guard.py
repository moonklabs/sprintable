"""story #4152/#4153 후속(CI·소형, 페드루 PO 確定 2026-09-22) — conftest.py의
`pytest_collection_modifyitems`가 destructive_schema 마커 항목에 적용하는 클래스 단위
timeout 상향(210초, pyproject.toml 전역 30초 대신)을 실 pytest 서브프로세스로 검증한다
(test_3186_mixed_collection_guard.py와 동일 subprocess+tmp_path 관례 — 발명 0).

실사고: pyproject.toml `[tool.pytest.ini_options] timeout=30`이 destructive_schema
파일마다 붙는 파일별 완전 격리(fresh DB·마이그레이션 replay 등)를 전제하지 않아,
정상적으로 30초를 넘는 파일(test_3804_prod_promotion_bridge_0354a.py, 60-마이그레이션
replay+pg_dump 스키마 대조, 등재 weight 85.0s)이 러너 부하와 무관하게 매번 하드킬됐다
(PR#4381 shard6 run, "Failed: Timeout (>30.0s) from pytest-timeout").

실 30+초 sleep 없이(CI 비용 0 추가) `pytest_collection_finish`로 각 item에 최종 적용된
`timeout` 마커 값만 stdout에 찍어 대조한다 — 마커 부여 자체가 판정 대상이지 실행 자체가
아니다."""
from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path


def _copy_conftest_with_timeout_probe(tmp_path: Path) -> None:
    conftest_src = (Path(__file__).parent / "conftest.py").read_text(encoding="utf-8")
    probe = textwrap.dedent(
        '''

        def pytest_collection_finish(session):
            for item in session.items:
                marker = item.get_closest_marker("timeout")
                print(f"TIMEOUT_PROBE::{item.nodeid}::{marker.args if marker is not None else None}")
        '''
    )
    (tmp_path / "conftest.py").write_text(conftest_src + probe, encoding="utf-8")


_DESTRUCTIVE_NO_OWN_TIMEOUT = """
    import pytest

    pytestmark = pytest.mark.destructive_schema

    def test_default_timeout_case():
        assert True
"""

_DESTRUCTIVE_WITH_OWN_TIMEOUT = """
    import pytest

    pytestmark = pytest.mark.destructive_schema

    @pytest.mark.timeout(45)
    def test_explicit_timeout_case():
        assert True
"""

_NON_DESTRUCTIVE_CASE = """
    def test_ordinary_case():
        assert True
"""


def _run_collect_only(tmp_path: Path, *marker_filter: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "pytest", str(tmp_path), *marker_filter, "--collect-only", "-q"],
        capture_output=True, text=True, cwd=tmp_path,
    )


def test_destructive_item_without_own_timeout_gets_210s_class_default(tmp_path: Path):
    """⭐핵심 — timeout 마커가 없는 destructive_schema 테스트는 collection 시점에
    210초로 상향된다(83s 관측 최댓값 × 2.5, #4152 ABSOLUTE_SLOW_MULTIPLIER와 같은 배수)."""
    (tmp_path / "test_4525_no_own_timeout.py").write_text(textwrap.dedent(_DESTRUCTIVE_NO_OWN_TIMEOUT))
    _copy_conftest_with_timeout_probe(tmp_path)

    result = _run_collect_only(tmp_path, "-m", "destructive_schema")
    assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"
    assert "TIMEOUT_PROBE::test_4525_no_own_timeout.py::test_default_timeout_case::(210,)" in result.stdout


def test_destructive_item_with_own_timeout_marker_is_respected_not_overwritten(tmp_path: Path):
    """자기 자신의 `@pytest.mark.timeout(45)`가 있으면 클래스 기본값(210)으로 덮어쓰지
    않는다 — 더 좁은 값을 명시한 파일의 의도를 존중."""
    (tmp_path / "test_4525_own_timeout.py").write_text(textwrap.dedent(_DESTRUCTIVE_WITH_OWN_TIMEOUT))
    _copy_conftest_with_timeout_probe(tmp_path)

    result = _run_collect_only(tmp_path, "-m", "destructive_schema")
    assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"
    assert "TIMEOUT_PROBE::test_4525_own_timeout.py::test_explicit_timeout_case::(45,)" in result.stdout


def test_non_destructive_item_regression_zero_stays_at_pyproject_default(tmp_path: Path):
    """회귀 0 — non-destructive 테스트는 이 가드의 대상이 아니다(마커 자체를 안 받음,
    pyproject.toml의 전역 timeout=30 그대로 — 이 가드가 전역 상한 자체를 바꾸지 않는다
    는 양성대조, PO "마커 빼면 30s 규칙 그대로" 요청과 동형)."""
    (tmp_path / "test_4525_ordinary.py").write_text(textwrap.dedent(_NON_DESTRUCTIVE_CASE))
    _copy_conftest_with_timeout_probe(tmp_path)

    result = _run_collect_only(tmp_path, "-m", "not destructive_schema")
    assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"
    assert "TIMEOUT_PROBE::test_4525_ordinary.py::test_ordinary_case::None" in result.stdout
