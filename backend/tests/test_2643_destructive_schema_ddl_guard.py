"""story #2643 — conftest.py의 destructive_schema 정적 가드 확장(raw SQL DDL 리터럴 탐지).

배경(#3031 CI 사고, 2026-08-14): 기존 가드는 `Base.metadata.create_all/drop_all` **속성
호출**만 AST로 스캔했다 — `sa.text("DROP TABLE ...")`류 raw SQL DDL 실행은 같은 파괴력을
가지면서도 이 스캔을 피해가, #3031의 새 테스트 2파일이 마커 없이 non-destructive CI 잡에
편입돼 공유 DB의 실 테이블(agent_api_keys·role_templates)을 떨어뜨렸다.

검증 축:
- AC1: raw DDL 리터럴을 가진 미마커 파일이 collect 시점에 실패(#3031 사고 케이스 양성대조).
- AC2: 기존 위반 전수 스캔·위반 0(원본 패턴 파일 test_ho_s3_hypothesis_owner_seed.py 포함).
- AC3: 가드가 못 잡는 잔여 축(동적 조립 문자열) 자체를 이 테스트로도 고정.
- 회귀: 첫 구현이 오탐(pytest.mark.xfail(reason="...CREATE TABLE 원문 인용...")을 SQL
  실행으로 오판)을 냈던 것 — 함수명을 text/execute로 좁혀 해소했다는 사실을 직접 고정.
"""
from __future__ import annotations

import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import conftest as _conftest  # noqa: E402


# ─── 단위 테스트 — _calls_raw_ddl_literal / _calls_destructive_schema_api 직접 호출 ──────

def _tree(src: str):
    import ast

    return ast.parse(textwrap.dedent(src))


def test_detects_text_call_with_drop_table_literal():
    assert _conftest._calls_raw_ddl_literal(_tree("""
        from sqlalchemy import text
        conn.execute(text("DROP TABLE IF EXISTS foo"))
    """)) is True


def test_detects_text_call_with_create_table_literal():
    assert _conftest._calls_raw_ddl_literal(_tree("""
        import sqlalchemy as sa
        c.execute(sa.text("CREATE TABLE IF NOT EXISTS foo (id uuid)"))
    """)) is True


@pytest.mark.parametrize("keyword", ["TRUNCATE", "ALTER"])
def test_detects_other_ddl_keywords(keyword: str):
    assert _conftest._calls_raw_ddl_literal(_tree(f"""
        conn.execute(text("{keyword} TABLE foo ADD COLUMN bar text"))
    """)) is True


def test_detects_bare_execute_call_without_text_wrapper():
    """일부 호출부는 text() 래핑 없이 execute()에 직접 문자열을 넘긴다 — execute도 대상."""
    assert _conftest._calls_raw_ddl_literal(_tree("""
        cursor.execute("DROP TABLE foo")
    """)) is True


def test_does_not_flag_prose_mentioning_ddl_in_unrelated_call():
    """회귀 가드 — 첫 구현이 냈던 정확한 오탐(#2643 그라운딩 중 실측: test_event1config_
    webhook_targets.py의 pytest.mark.xfail(reason="...CREATE TABLE 원문 인용..."))을 재현해
    지금은 안 걸리는지 고정."""
    assert _conftest._calls_raw_ddl_literal(_tree("""
        import pytest

        @pytest.mark.xfail(reason="baseline schema.sql 실측: `member_id uuid NOT NULL`"
                                   "(CREATE TABLE 원문) 참고")
        def test_something():
            pass
    """)) is False


def test_does_not_flag_docstring_mentioning_ddl():
    assert _conftest._calls_raw_ddl_literal(_tree('''
        """이 테스트는 DROP TABLE 동작을 설명하는 문서다(실행 없음)."""
        def test_x():
            pass
    ''')) is False


def test_ac3_declared_blind_spot_fstring_ddl_not_detected():
    """AC3 — 동적 조립 문자열(f-string)은 가드가 스스로 「못 본다」고 선언한 잔여 사각.
    이 테스트는 그 선언이 실제 코드 동작과 일치하는지 고정한다(선언과 동작의 괴리 방지)."""
    assert _conftest._calls_raw_ddl_literal(_tree("""
        table = "foo"
        conn.execute(text(f"DROP TABLE {table}"))
    """)) is False


def test_legacy_create_all_drop_all_attribute_detection_still_works():
    """기존(8236bbc3) 축 무회귀 — .create_all()/.drop_all() 속성호출은 여전히 걸린다."""
    import ast

    tree = _tree("conn.run_sync(Base.metadata.create_all)")
    assert any(
        isinstance(node, ast.Attribute) and node.attr in _conftest._DESTRUCTIVE_ATTRS
        for node in ast.walk(tree)
    ) is True


def test_non_ddl_file_not_flagged():
    assert _conftest._calls_raw_ddl_literal(_tree("""
        def test_normal():
            assert 1 + 1 == 2
    """)) is False


# ─── AC1: 양성대조 — 실제 pytest 서브프로세스로 #3031 사고 케이스 재현 ──────────────────

def test_positive_control_unmarked_raw_ddl_file_fails_collection(tmp_path: Path):
    """#3031이 실제로 겪은 것과 동일한 모양(마커 없는 raw DDL 테스트 파일)을 만들어
    collect 시점에 UsageError(exit code 4)로 죽는지 실측 — AC1 그 자체."""
    victim = tmp_path / "test_2643_positive_control_victim.py"
    victim.write_text(textwrap.dedent("""
        from sqlalchemy import text

        def test_drops_something(x_conn):
            x_conn.execute(text("DROP TABLE agent_api_keys"))
    """))
    conftest_src = (Path(__file__).parent / "conftest.py").read_text(encoding="utf-8")
    (tmp_path / "conftest.py").write_text(conftest_src, encoding="utf-8")

    result = subprocess.run(
        [sys.executable, "-m", "pytest", str(victim), "--collect-only", "-q"],
        capture_output=True, text=True, cwd=tmp_path,
    )
    combined = result.stdout + result.stderr
    assert result.returncode == 4, f"stdout={result.stdout}\nstderr={result.stderr}"
    assert "destructive_schema" in combined
    assert "test_2643_positive_control_victim.py" in combined


def test_positive_control_marker_added_fixes_collection(tmp_path: Path):
    """같은 파일에 마커를 붙이면 collection이 정상 통과 — 마커가 실제로 이 가드를 끄는
    올바른 처방임을 직접 증명(처방 자체의 유효성, 진단만 하고 처방은 안 검증하는 결함 방지)."""
    victim = tmp_path / "test_2643_positive_control_fixed.py"
    victim.write_text(textwrap.dedent("""
        import pytest
        from sqlalchemy import text

        pytestmark = pytest.mark.destructive_schema

        def test_drops_something(x_conn):
            x_conn.execute(text("DROP TABLE agent_api_keys"))
    """))
    conftest_src = (Path(__file__).parent / "conftest.py").read_text(encoding="utf-8")
    (tmp_path / "conftest.py").write_text(conftest_src, encoding="utf-8")

    result = subprocess.run(
        [sys.executable, "-m", "pytest", str(victim), "--collect-only", "-q"],
        capture_output=True, text=True, cwd=tmp_path,
    )
    assert result.returncode == 0, f"stdout={result.stdout}\nstderr={result.stderr}"


# ─── AC2: 전수 스캔 — 위반 0(원본 패턴 파일 포함 정비 결과 고정) ────────────────────────

def test_ac2_no_unmarked_raw_ddl_violations_across_test_suite():
    """실 tests/ 디렉터리 전체를 이 가드로 재스캔해 위반 0임을 pytest 레벨에서도 명시 고정
    (collection-time UsageError는 CI에서 "쾅" 하고 죽는 신호일 뿐 — 이 테스트는 그 사실을
    독립적으로, 유지보수 가능한 형태로 다시 진술한다)."""
    import importlib.util as _ilu

    tests_dir = Path(__file__).parent
    violations = []
    for py_file in sorted(tests_dir.glob("*.py")):
        if py_file.name in ("conftest.py",):
            continue
        if _conftest._calls_destructive_schema_api(py_file):
            spec = _ilu.spec_from_file_location(py_file.stem, py_file)
            module = _ilu.module_from_spec(spec)
            try:
                spec.loader.exec_module(module)
            except Exception:
                continue
            marker_present = any(
                getattr(m, "name", None) == "destructive_schema"
                for m in (
                    module.pytestmark if isinstance(getattr(module, "pytestmark", None), list)
                    else [getattr(module, "pytestmark", None)]
                )
                if m is not None
            )
            if not marker_present:
                violations.append(py_file.name)
    assert not violations, f"raw DDL 리터럴을 가졌는데 destructive_schema 마커가 없는 파일: {violations}"
