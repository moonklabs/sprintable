"""story a05da51b — realdb 테스트 전역 엔진 dispose 하네스의 두 가드를 양성/음성 대조로
고정한다.

배경: story #3330(PR#3711)이 conftest.py의 `pytest_collection_modifyitems`에 「non-
destructive **async** 테스트에만 `_dispose_global_engine_for_non_destructive_tests`를
collection 시점에 자동 주입」을 심었다(파일별 opt-in fixture의 구조적 구멍을 막기 위해
— "그 파일 작성자가 전역 엔진 위험을 알고 있었는가"에 기대지 않는다). 이 자동 주입
메커니즘이 조용히 깨지면(예: 누군가 `pytest_collection_modifyitems`의 그 블록을 실수로
지우거나 조건을 바꾸면) CI가 다시 #3330 flake급으로 빨개지는데, 그걸 알아챌 회귀가드가
지금까지 없었다 — 이 파일이 그 가드다.

1부(async 자동 주입 회귀가드) — `test_3186_mixed_collection_guard.py`와 동일한 subprocess
+ tmp_path + conftest.py 복사 관례(pytest 내장 `--setup-plan`으로 실제 fixture 주입 여부를
실행 없이 확인 — story #2662/#3186이 이미 쓰는 검증 방식과 동형).
2부(destructive publish-path lint 가드) — `scripts/lint_destructive_publish_path_dispose_
fixture.py`를 직접 import해 단위 검증(파일 I/O 없이 순수 함수 축)."""
from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path


def _copy_conftest(tmp_path: Path) -> None:
    conftest_src = (Path(__file__).parent / "conftest.py").read_text(encoding="utf-8")
    (tmp_path / "conftest.py").write_text(conftest_src, encoding="utf-8")


_ASYNC_NON_DESTRUCTIVE_VICTIM = """
    import pytest

    @pytest.fixture
    def anyio_backend():
        return "asyncio"

    @pytest.mark.anyio
    async def test_ordinary_async():
        assert 1 + 1 == 2
"""

_SYNC_NON_DESTRUCTIVE_VICTIM = """
    def test_ordinary_sync():
        assert 1 + 1 == 2
"""

_ASYNC_DESTRUCTIVE_VICTIM = """
    import pytest

    pytestmark = pytest.mark.destructive_schema

    @pytest.fixture
    def anyio_backend():
        return "asyncio"

    @pytest.mark.anyio
    async def test_destructive_async():
        assert 1 + 1 == 2
"""

_FIXTURE_NAME = "_dispose_global_engine_for_non_destructive_tests"


def _run_setup_plan(tmp_path: Path, extra_args: list[str]) -> str:
    result = subprocess.run(
        [sys.executable, "-m", "pytest", str(tmp_path), "--setup-plan", "-q", *extra_args],
        capture_output=True, text=True, cwd=tmp_path,
        env={"PARITY_TEST_DATABASE_URL": "", "ALEMBIC_DATABASE_URL": "", "PATH": __import__("os").environ["PATH"]},
    )
    return result.stdout + result.stderr


def test_positive_control_async_non_destructive_test_gets_dispose_fixture_injected(tmp_path: Path):
    """⭐AC — 이 fixture가 collection 시점에 실제로 주입되는지(뮤테이션 대상: conftest.py의
    주입 루프를 지우면 이 테스트가 RED가 된다 — 아래 뮤테이션 절 참조)."""
    (tmp_path / "test_async_victim.py").write_text(textwrap.dedent(_ASYNC_NON_DESTRUCTIVE_VICTIM))
    _copy_conftest(tmp_path)

    output = _run_setup_plan(tmp_path, [])
    assert f"SETUP    F {_FIXTURE_NAME}" in output, f"async non-destructive 테스트에 dispose fixture가 주입되지 않음\n{output}"


def test_sync_non_destructive_test_does_not_get_dispose_fixture_injected(tmp_path: Path):
    """음성대조 — sync 테스트는 이 fixture를 몰라야 한다(story #2662 회귀 방지 —
    async fixture가 sync 테스트에 autouse로 걸리면 PytestRemovedIn9Warning으로
    서브프로세스 메타테스트 출력이 깨진다, PR#3711 카디르 QA 실측)."""
    (tmp_path / "test_sync_victim.py").write_text(textwrap.dedent(_SYNC_NON_DESTRUCTIVE_VICTIM))
    _copy_conftest(tmp_path)

    output = _run_setup_plan(tmp_path, [])
    assert _FIXTURE_NAME not in output, f"sync 테스트에 dispose fixture가 주입됨(회귀)\n{output}"
    assert "PytestRemovedIn9Warning" not in output, f"sync 테스트에서 async fixture 경고 발생(회귀)\n{output}"


def test_destructive_async_test_does_not_get_dispose_fixture_injected(tmp_path: Path):
    """음성대조 — destructive_schema 마커 async 테스트도 이 fixture를 몰라야 한다(스코프=
    non-destructive만, story #3330 PO 확定). destructive 파일은 파일별 완전 격리
    프로세스라 이 conftest-레벨 자동 방어가 애초에 불필요 — 발행 경로를 타는 destructive
    파일은 대신 개별 `_dispose_global_engine_after_test`(scripts/lint_destructive_
    publish_path_dispose_fixture.py 가드 대상)를 쓴다."""
    (tmp_path / "test_destructive_victim.py").write_text(textwrap.dedent(_ASYNC_DESTRUCTIVE_VICTIM))
    _copy_conftest(tmp_path)

    output = _run_setup_plan(tmp_path, ["-m", "destructive_schema"])
    assert _FIXTURE_NAME not in output, f"destructive 마커 테스트에 dispose fixture가 주입됨(스코프 위반)\n{output}"


# ─────────────────────────────────────────────────────────────────────────────
# 2부 — lint_destructive_publish_path_dispose_fixture.py 단위 검증(순수 함수, 파일 I/O 없이
# ast.parse 대상 소스만 직접 구성 — lint_destructive_test_sql.py에 대응하는 단위 테스트가
# 이 조직에 아직 없어 이 파일이 그 축까지 함께 고정한다).
# ─────────────────────────────────────────────────────────────────────────────

def _lint_module():
    import importlib.util

    path = Path(__file__).parent.parent / "scripts" / "lint_destructive_publish_path_dispose_fixture.py"
    spec = importlib.util.spec_from_file_location("lint_destructive_publish_path_dispose_fixture", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_and_check(tmp_path: Path, filename: str, source: str):
    p = tmp_path / filename
    p.write_text(textwrap.dedent(source), encoding="utf-8")
    return _lint_module().find_violation(p)


def test_lint_flags_destructive_file_with_trigger_call_and_no_fixture(tmp_path: Path):
    """⭐AC — 발행 경로 트리거 + destructive 마커 + fixture 없음 → 위반 검출."""
    violation = _write_and_check(tmp_path, "test_victim.py", """
        import pytest
        pytestmark = pytest.mark.destructive_schema

        async def test_x():
            await publish_registry_event(x, y)
    """)
    assert violation is not None
    file, triggers = violation
    assert "publish_registry_event" in triggers


def test_lint_passes_when_fixture_present(tmp_path: Path):
    """음성대조 — 같은 트리거가 있어도 fixture 문자열이 파일에 있으면 통과."""
    violation = _write_and_check(tmp_path, "test_victim.py", """
        import pytest
        pytestmark = pytest.mark.destructive_schema

        @pytest.fixture(autouse=True)
        async def _dispose_global_engine_after_test():
            yield

        async def test_x():
            await publish_registry_event(x, y)
    """)
    assert violation is None


def test_lint_passes_when_no_trigger_call(tmp_path: Path):
    """음성대조 — destructive 마커만 있고 트리거 호출이 없으면 fixture 없어도 통과
    (이 가드는 "발행 경로를 타는" 파일만 요구한다 — 모든 destructive 파일에 강제하지
    않는다)."""
    violation = _write_and_check(tmp_path, "test_victim.py", """
        import pytest
        pytestmark = pytest.mark.destructive_schema

        def test_x():
            assert 1 == 1
    """)
    assert violation is None


def test_lint_passes_when_not_destructive_marked(tmp_path: Path):
    """음성대조 — 마커 자체가 없으면(non-destructive 파일) 이 가드의 대상이 아니다
    (그쪽은 conftest.py 자동 주입이 이미 커버 — 1부 테스트들)."""
    violation = _write_and_check(tmp_path, "test_victim.py", """
        async def test_x():
            await publish_registry_event(x, y)
    """)
    assert violation is None


def test_lint_respects_allow_marker(tmp_path: Path):
    """양성대조 — `# dispose-fixture-not-needed:` 마커가 파일에 있으면 통과."""
    violation = _write_and_check(tmp_path, "test_victim.py", """
        import pytest
        pytestmark = pytest.mark.destructive_schema

        # dispose-fixture-not-needed: 이 테스트는 publish_registry_event를 항상 mock한다.
        async def test_x():
            await publish_registry_event(x, y)
    """)
    assert violation is None
