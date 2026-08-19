"""story #2786 — lint_destructive_test_sql.py의 정탐/오탐 회귀 가드. 실물 파일이 아니라
합성 fixture로 짓는다(실물이 고쳐져도 이 테스트는 안 사라진다, story #2335/#2342 lint와 동형).

양성대조 2종은 사고 «원문 그대로»(PR#3088 DROP SCHEMA·PR#3217 DELETE FROM)를 fixture화한다."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))
from lint_destructive_test_sql import find_violations, scan_dir  # noqa: E402


def _write(tmp_path: Path, name: str, source: str) -> Path:
    p = tmp_path / name
    p.write_text(source)
    return p


# ── 양성대조: 두 사고 원문 그대로 ──────────────────────────────────────────

def test_positive_control_pr3217_delete_without_where(tmp_path):
    """PR#3217 원문(story #2777) — WHERE 없는 DELETE FROM offering_versions, autouse fixture 안."""
    src = '''
import pytest

@pytest.fixture(autouse=True)
async def _seed(session):
    await session.execute(text("DELETE FROM offering_versions"))
    yield
'''
    path = _write(tmp_path, "test_bad_3217.py", src)
    violations = find_violations(path)
    assert len(violations) == 1
    assert "WHERE절 없음" in violations[0][2]


def test_positive_control_pr3088_drop_schema(tmp_path):
    """PR#3088 원문(story #2662) — destructive_schema 마커 없는 임의 파일의 DROP SCHEMA."""
    src = '''
def reset(conn):
    conn.execute(text("DROP SCHEMA public CASCADE"))
'''
    path = _write(tmp_path, "test_bad_3088.py", src)
    violations = find_violations(path)
    assert len(violations) == 1
    assert "무조건 위반" in violations[0][2]


def test_positive_control_subdirectory_violation_is_scanned(tmp_path):
    """story #2786 재QA(PO 격상, 디디 3221 fix) — pytest는 tests/ 하위 서브디렉토리(예:
    tests/mcp/)까지 재귀 실행하는데, top-level glob만 쓰면 그 파일들이 스캔 밖인데 pytest는
    도는 «거짓 안전 신호»가 된다. 이 테스트는 정확히 그 시나리오를 재현 — 하위 폴더의 위반이
    scan_dir()에 실제로 잡히는지 고정한다."""
    sub = tmp_path / "mcp"
    sub.mkdir()
    (sub / "__init__.py").write_text("")
    src = '''
async def cleanup(session):
    await session.execute(text("DELETE FROM webhook_events"))
'''
    _write(sub, "test_nested_bad.py", src)
    violations, scanned = scan_dir(tmp_path)
    assert scanned == 2  # __init__.py + test_nested_bad.py
    assert len(violations) == 1
    assert "WHERE절 없음" in violations[0][2]
    assert "mcp" in violations[0][0]  # 서브디렉토리 경로가 보고에 실제로 찍히는지


# ── 음성대조: 정상 관례는 통과 ──────────────────────────────────────────────

def test_negative_control_on_conflict_seed_pattern_passes(tmp_path):
    """ON CONFLICT DO NOTHING seed(예: test_2776 _seed_offering()류) — DELETE/DROP/TRUNCATE
    자체가 없어 이 가드의 정규식과 애초에 매치하지 않는다(파괴적 연산이 아니므로 당연 통과)."""
    src = '''
from sqlalchemy.dialects.postgresql import insert as pg_insert

async def seed(session, tier):
    stmt = pg_insert(OfferingVersion).values(tier=tier).on_conflict_do_nothing(
        index_elements=["tier", "currency"],
    )
    await session.execute(stmt)
'''
    path = _write(tmp_path, "test_seed_ok.py", src)
    assert find_violations(path) == []


def test_negative_control_where_scoped_delete_passes(tmp_path):
    """WHERE로 자기 데이터만 지우는 self-cleanup 관례(백엔드 테스트 90여 자리 실측 패턴) — 통과."""
    src = '''
async def cleanup(session, org_id):
    await session.execute(text("DELETE FROM org_members WHERE org_id=:o"), {"o": org_id})
'''
    path = _write(tmp_path, "test_cleanup_ok.py", src)
    assert find_violations(path) == []


def test_negative_control_destructive_schema_module_marker_exempts_file(tmp_path):
    """pytestmark = pytest.mark.destructive_schema — story #2293 격리 shard에서 도니 통과."""
    src = '''
import pytest

pytestmark = pytest.mark.destructive_schema


def test_rebuild(conn):
    conn.execute(text("DROP TABLE IF EXISTS scratch"))
    conn.execute(text("TRUNCATE workflow_line_step_runs CASCADE"))
'''
    path = _write(tmp_path, "test_isolated_ok.py", src)
    assert find_violations(path) == []


def test_negative_control_destructive_schema_function_decorator_exempts_file(tmp_path):
    """함수 데코레이터 형태(@pytest.mark.destructive_schema)도 모듈 대입과 동일하게 통과."""
    src = '''
import pytest

@pytest.mark.destructive_schema
def test_rebuild(conn):
    conn.execute(text("TRUNCATE gate CASCADE"))
'''
    path = _write(tmp_path, "test_isolated_deco_ok.py", src)
    assert find_violations(path) == []


def test_negative_control_explicit_allow_marker_exempts_line(tmp_path):
    """destructive_schema 마커 없는 파일이라도 명시 사유 마커가 있으면 그 줄만 통과."""
    src = '''
def reset(conn):
    # destructive-sql-allow: 이미 위에서 assert_disposable_test_db()로 검증된 자리
    conn.execute(text("DROP SCHEMA public CASCADE"))
'''
    path = _write(tmp_path, "test_marked_ok.py", src)
    assert find_violations(path) == []


def test_allow_marker_only_covers_its_own_line(tmp_path):
    """마커가 붙은 줄만 면제 — 같은 파일의 다른 무마커 위반은 여전히 잡힌다."""
    src = '''
def reset(conn):
    # destructive-sql-allow: 이 줄만 봐준다
    conn.execute(text("DROP SCHEMA public CASCADE"))
    conn.execute(text("DELETE FROM users"))
'''
    path = _write(tmp_path, "test_partial_marked.py", src)
    violations = find_violations(path)
    assert len(violations) == 1
    assert "WHERE절 없음" in violations[0][2]


# ── 선언된 사각(못 잡는 것) — 문서화된 한계가 실제로 안 잡힌다는 걸 자기증명 ──

def test_declared_blind_spot_fstring_delete_is_silently_not_caught(tmp_path):
    """f-string 동적조립 DELETE — AST 리터럴이 아니라 이 가드가 원천적으로 못 본다(문서화된
    한계, story #2643과 동일 계층). 이 테스트는 «못 잡는다»는 사실 자체를 고정한다 —
    누군가 이 가드를 고쳐 잡게 만들면 이 테스트가 실패해 그 확장을 표면화한다."""
    src = '''
def cleanup(conn, table):
    conn.execute(text(f"DELETE FROM {table}"))
'''
    path = _write(tmp_path, "test_fstring_blindspot.py", src)
    assert find_violations(path) == []


def test_declared_blind_spot_orm_delete_is_silently_not_caught(tmp_path):
    """ORM delete() 호출 — 문자열 리터럴이 아니라 이 스캐너의 대상 밖(문서화된 한계)."""
    src = '''
from sqlalchemy import delete

async def cleanup(session):
    await session.execute(delete(Model))
'''
    path = _write(tmp_path, "test_orm_blindspot.py", src)
    assert find_violations(path) == []
