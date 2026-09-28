"""story #3804(BE·prod 승격 재료) — 0354a 브릿지(main↔develop 4곳 갈림·60개 유령
스킵 정정)를 실 PG로 재현·검증한다. test_f6d1bbaa_stamp_integrity_guard.py(0253a
선례)와 동형 하네스: `_apply_upgrade_directly`로 특정 리비전만 체인과 무관하게
직접 적용해 "main이 실제로 밟았던 그 경로"를 재현한다.

검증 축(AC3):
- 정상 환경(전체 체인 순차 적용) → `upgrade head` 시 0354a가 완전 no-op·로그 4줄
  전부 skip.
- prodlike(main 경로 그대로: 0283/0289/0292/0354를 직접 적용+stamp, 나머지는 정상
  upgrade) → `upgrade head` 시 60개 재생·devfresh 대비 `pg_dump --schema-only` diff 0.
- 부분 실패 주입(구간④ 재생 중 예외) → 단일 트랜잭션이라 구간①②③까지 이미 실행된
  DDL도 전부 롤백(추가 코드 없이 env.py `transaction_per_migration=False` 하나로).
- dry-run(`ALEMBIC_0354A_DRY_RUN=1`) → SAVEPOINT 롤백 + 의도된 예외로 상위 트랜잭션도
  롤백 — 스키마·alembic_version 둘 다 완전 무변.
- 뮤테이션(구간② 게이트 컬럼명 오타) → PO CHANGES 1회차(C1) 도입 전에는 devfresh 대비
  schema diff에서만 드러났지만, 지금은 `_require_exists`(사후 존재-체크)가 더 이른
  지점에서 RuntimeError로 직접 잡는다 — 그 사실을 실증.
- 뮤테이션(구간④ 마지막 파일 0353을 조용한 no-op으로) → `channel_connections`(초입
  산출물)만 보는 체크로는 못 잡지만 `channel_post_versions.hook_key`(구간 끝 산출물)
  까지 보는 사후 체크는 잡는다는 것을 실증(C1 지정 케이스).

⛔ prod 승격 판(결제 축 제외 · 2026-09-28 · story #4391): 구간①~③(0282 · 0288 · 0291)은 결제 축이라 이 파일셋에
없고(main이 0283←0281 · 0289←0287 · 0292←0290으로 재봉합) 0354a도 구간④만 재생한다 — 아래 단언은 구간④ 하나 기준으로
맞췄다(스킵 줄 1 · 재생 줄 1 · 부분 실패 = 구간④ DDL 실행 뒤 예외 · 게이트 오타 뮤테이션 = 구간④ 게이트).

구간④ 파일 목록(57개) 자체의 드리프트 가드(C2, `_SEGMENT_*_FILES` ↔
`alembic/versions/` glob 대조)는 실 DB가 불필요해 `test_3804_segment_files_drift_guard.py`
로 분리했다(destructive_schema 마커 없이 상시 스윗에서 돎).
"""
from __future__ import annotations

import importlib.util
import os
import subprocess
import uuid
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL 미설정"),
    pytest.mark.destructive_schema,
]

_BACKEND_DIR = Path(__file__).parent.parent
_VERSIONS_DIR = _BACKEND_DIR / "alembic" / "versions"
_BRIDGE_FILE = _VERSIONS_DIR / "0354a_prod_promotion_skipped_migrations_replay.py"


def _admin_url() -> str:
    # story #3804 rebase(미르코, 페드루 PO 지시) — str(URL)은 SQLAlchemy가 기본으로
    # password를 "***"로 마스킹한다(안전 로깅 기본값) — 그 문자열로 create_engine하면
    # 실 비밀번호 대신 리터럴 "***"로 접속을 시도해 password authentication failed로
    # 깨진다(로컬 실측, throwaway PG 비밀번호 인증 환경에서 100% 재현). test_3522/
    # test_4010이 이미 쓰는 render_as_string(hide_password=False)가 정본 우회.
    return make_url(_REAL_DB_URL).set(database="postgres").render_as_string(hide_password=False)


def _create_disposable_db() -> str:
    dbname = f"test3804_{uuid.uuid4().hex[:16]}"
    admin_engine = create_engine(_admin_url(), isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        conn.execute(sa.text(f'CREATE DATABASE "{dbname}"'))
    admin_engine.dispose()

    url = make_url(_REAL_DB_URL).set(database=dbname).render_as_string(hide_password=False)
    eng = create_engine(url)
    with eng.connect() as conn:
        # app.models가 vector 컬럼을 선언해 확장 없이는 baseline snapshot 적용이 실패한다.
        conn.execute(sa.text("CREATE EXTENSION IF NOT EXISTS vector"))
        conn.commit()
    eng.dispose()
    return url


def _drop_disposable_db(url: str) -> None:
    dbname = make_url(url).database
    admin_engine = create_engine(_admin_url(), isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        conn.execute(sa.text(f'DROP DATABASE IF EXISTS "{dbname}" WITH (FORCE)'))
    admin_engine.dispose()


@pytest.fixture
def new_test_db():
    """호출할 때마다(팩토리) 완전히 새 disposable DB를 만든다 — 이 파일은 **한 테스트
    안에서 prodlike+devfresh 두 DB를 동시에** 띄워야 해서, 평범한 function-scope
    픽스처 하나를 두 곳(prodlike_db·fresh_db)이 공유하면 캐싱 때문에 «같은 DB»가
    되어버린다(2026-09-16 최초 구현에서 실제로 이렇게 걸림 — 뮤테이션 테스트가 자기
    자신과 diff를 떠 항상 통과하는 무결성 0 상태였다). 팩토리로 호출부마다 독립 DB를
    보장한다."""
    created: list[str] = []

    def _factory() -> str:
        url = _create_disposable_db()
        created.append(url)
        return url

    yield _factory

    for url in created:
        _drop_disposable_db(url)


def _apply_upgrade_directly(url: str, filename_prefix: str) -> None:
    """지정 접두사로 시작하는 리비전 파일 하나를 alembic 체인과 무관하게 직접
    upgrade()만 실행 — main이 실제로 밟은 "스킵 지점" 재현용(0253a 선례 동형)."""
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
        capture_output=True, text=True, check=False,
    )


def _build_prodlike_at_0354(url: str) -> None:
    """main이 실제로 승격했던 경로 그대로: 0281까지 정상, 0283/0289/0292/0354는 직접
    적용(develop 파일과 upgrade() 본문이 바이트동일 — down_revision·docstring만 갈림,
    2026-09-16 diff 재확認)+stamp, 나머지는 정상 upgrade. 4곳 전부 스킵된 채 "0354"에
    도달한다."""
    # 결제 제외 승격 판: 0283 · 0289 · 0292는 이 파일셋에서 이미 0281 · 0287 · 0290에 이어져 있어 정상 체인으로 0295까지 간다.
    r = _run_alembic(url, "upgrade", "0295")
    assert r.returncode == 0, r.stderr

    _apply_upgrade_directly(url, "0354_")
    r = _run_alembic(url, "stamp", "0354")
    assert r.returncode == 0, r.stderr


def _dump_schema(url: str) -> str:
    """`--schema-only`를 pg_dump 연결정보로 직접 돌린다(url은 psycopg2 스킴이라
    pg_dump가 바로 못 먹는 asyncpg류가 아님 — 그대로 파싱 가능한 DSN 조각만 추출)."""
    from sqlalchemy.engine import make_url

    u = make_url(url)
    env = {**os.environ, "PGPASSWORD": u.password or ""}
    cmd = [
        "pg_dump", "--schema-only", "--no-owner", "--no-privileges",
        "-h", u.host or "localhost", "-p", str(u.port or 5432),
        "-U", u.username or "", "-d", u.database or "",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, check=False)
    assert r.returncode == 0, r.stderr
    # \restrict/\unrestrict 토큰은 pg_dump 호출마다 난수라 스키마 내용이 아니다 — 비교 전 제거.
    lines = [ln for ln in r.stdout.splitlines() if not ln.startswith("\\restrict") and not ln.startswith("\\unrestrict")]
    return "\n".join(ln for ln in lines if ln.strip() and not ln.startswith("--"))


@pytest.fixture
def prodlike_db(new_test_db):
    """독립 disposable DB → main 경로(4곳 스킵) 재현. 개별 테스트가 여기서부터 head까지
    이어간다. fresh_db와 반드시 별도 DB(new_test_db 팩토리를 각자 한 번씩 호출)."""
    url = new_test_db()
    _build_prodlike_at_0354(url)
    return url


@pytest.fixture
def fresh_db(new_test_db):
    """prodlike_db와 별개인 독립 disposable DB — devfresh(정상 순차 적용) 비교 대상."""
    return new_test_db()


def test_ac2_fresh_env_head_upgrade_is_noop_one_skip_line(fresh_db):
    r = _run_alembic(fresh_db, "upgrade", "head")
    assert r.returncode == 0, r.stderr
    combined = r.stdout + r.stderr
    assert combined.count("skip(이미 존재)") == 1, combined

    r = _run_alembic(fresh_db, "current")
    assert "head" in (r.stdout + r.stderr), r.stdout + r.stderr


def test_ac3_prodlike_replay_matches_devfresh_schema(prodlike_db, fresh_db):
    r = _run_alembic(prodlike_db, "upgrade", "head")
    assert r.returncode == 0, r.stderr
    combined = r.stdout + r.stderr
    assert combined.count("재생함") == 1, combined

    r = _run_alembic(fresh_db, "upgrade", "head")
    assert r.returncode == 0, r.stderr

    prodlike_schema = _dump_schema(prodlike_db)
    devfresh_schema = _dump_schema(fresh_db)
    assert prodlike_schema == devfresh_schema


def test_ac3_partial_failure_rolls_back_all_segments(prodlike_db, monkeypatch):
    """구간④ 재생을 끝까지 실행한 **뒤** 예외를 주입 — 이미 실행된 구간④ DDL(channel_connections 등)까지 전부
    롤백되는지(단일 트랜잭션, 추가 코드 없이 env.py 기본 설정만으로 보장)를 직접 실증."""
    engine = create_engine(prodlike_db)

    spec = importlib.util.spec_from_file_location("mig0354a_partial_fail", str(_BRIDGE_FILE))
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)

    original_replay = mig._replay
    call_order: list[list[str]] = []

    def _replay_boom(filenames: list[str]) -> None:
        call_order.append(filenames)
        original_replay(filenames)
        raise RuntimeError("injected failure — story #3804 부분 실패 시뮬레이션")

    monkeypatch.setattr(mig, "_replay", _replay_boom)

    with pytest.raises(RuntimeError, match="injected failure"), engine.begin() as conn:
        ctx = MigrationContext.configure(conn)
        op_obj = Operations(ctx)
        import alembic.op as op_module
        op_module._proxy = op_obj
        mig.upgrade()

    # 구간④가 실제로 재생된 뒤 터졌음을 확認 — 그래야 "이미 실행된 DDL이 롤백됐다"는 주장이 의미가 있다.
    assert call_order == [mig._SEGMENT_4_FILES]

    with engine.connect() as verify_conn:
        insp = sa.inspect(verify_conn)
        assert "channel_connections" not in insp.get_table_names(), "구간④ DDL이 롤백 안 됨"
        assert "channel_post_versions" not in insp.get_table_names(), "구간④ DDL이 롤백 안 됨"

    engine.dispose()


def test_ac3_dry_run_leaves_schema_and_alembic_version_unchanged(prodlike_db):
    env = {**os.environ, "ALEMBIC_DATABASE_URL": prodlike_db, "ALEMBIC_0354A_DRY_RUN": "1"}
    r = subprocess.run(
        ["uv", "run", "alembic", "upgrade", "0354a"], cwd=_BACKEND_DIR, env=env,
        capture_output=True, text=True, check=False,
    )
    combined = r.stdout + r.stderr
    assert r.returncode != 0, f"dry-run은 상위 트랜잭션까지 롤백시키려 의도적으로 실패해야 한다:\n{combined}"
    assert "SAVEPOINT 롤백" in combined
    assert combined.count("재생함") == 0 or "판정" in combined  # 요약은 찍히되 실적용은 없다
    assert "구간④ 0296~0353" in combined, combined
    for gone in ("구간① 0282", "구간② 0288", "구간③ 0291"):
        assert gone not in combined, combined

    r = _run_alembic(prodlike_db, "current")
    assert "0354 " in (r.stdout + r.stderr) or (r.stdout + r.stderr).strip().startswith("0354"), r.stdout + r.stderr

    engine = create_engine(prodlike_db)
    with engine.connect() as conn:
        insp = sa.inspect(conn)
        assert "channel_connections" not in insp.get_table_names()
    engine.dispose()


def _load_mutant(mutated_src: str, tmp_dir: Path):
    """alembic/versions/ 밖에 둔다 — 그 안에 두면 ScriptDirectory가 revision="0354a"를
    두 파일에서 동시에 봐 "Multiple head revisions" 오류가 난다(이 목업은 alembic CLI
    스캔 대상이 아니라 importlib로 직접 한 번만 실행하는 용도). `_load_upgrade_fn`이
    `os.path.dirname(__file__)`로 형제 세그먼트 파일을 찾으므로 `__file__`만 versions/로
    되돌려준다(파일 자체는 tmp_dir에 둔 채)."""
    tmp_mutant = tmp_dir / "mutant_0354a.py"
    tmp_mutant.write_text(mutated_src, encoding="utf-8")
    spec = importlib.util.spec_from_file_location("mig0354a_mutant", str(tmp_mutant))
    mig = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mig)
    mig.__file__ = str(_VERSIONS_DIR / "mutant_0354a.py")
    return mig


def test_mutation_segment4_gate_table_typo_now_caught_by_posthoc_check(prodlike_db):
    """양성대조 — 구간④ 게이트가 실재하는 무관 테이블(platform_settings, 훨씬 이른 공통 조상에서 이미 생긴 표)을
    잘못 확認하도록 오타를 주입하면, prodlike에서 "이미 있다"고 오판해 구간④를 잘못 skip한다. `_require_exists`가
    구간④ 직후 `channel_connections` 부재를 즉시 잡아 RuntimeError로 트랜잭션 전체를 롤백시키는지 직접 실증한다.
    (결제 제외 승격 판: 원래의 구간② 게이트 뮤테이션은 구간②가 없어져 같은 형태로 구간④ 게이트에 옮겼다.)"""
    import tempfile

    src = _BRIDGE_FILE.read_text(encoding="utf-8")
    mutated_src = src.replace(
        'if "channel_connections" not in inspector.get_table_names():',
        'if "platform_settings" not in inspector.get_table_names():',
    )
    assert mutated_src != src, "치환 대상 문자열을 못 찾음 — 마이그 본문이 바뀐 것"

    tmp_dir = Path(tempfile.mkdtemp(prefix="3804-mutant-"))
    try:
        mig = _load_mutant(mutated_src, tmp_dir)
        engine = create_engine(prodlike_db)
        with pytest.raises(RuntimeError, match="channel_connections"), engine.begin() as conn:
            ctx = MigrationContext.configure(conn)
            op_obj = Operations(ctx)
            import alembic.op as op_module
            op_module._proxy = op_obj
            mig.upgrade()
        engine.dispose()
    finally:
        import shutil

        shutil.rmtree(tmp_dir, ignore_errors=True)


def test_mutation_segment4_last_file_silent_noop_caught_by_posthoc_check(prodlike_db):
    """PO CHANGES 1회차 C1 지정 뮤테이션 — 구간④ 마지막 파일(0353, hook_key)의
    upgrade()를 빈 함수로 바꾸면(파일 순서상 앞의 0296~0351은 정상 재생돼
    channel_connections 등은 생기지만 hook_key만 조용히 안 생긴다) `_require_exists`가
    `channel_post_versions.hook_key` 부재를 잡아 RuntimeError → 트랜잭션 전체 롤백.
    구간④ 초입 산출물(channel_connections)만 보는 체크로는 이 결함을 못 잡는다는
    것까지 같이 고정한다(그래서 C1이 두 산출물을 같이 본다)."""
    import tempfile

    src = _BRIDGE_FILE.read_text(encoding="utf-8")
    mutated_src = src.replace(
        'def _load_upgrade_fn(filename: str):',
        'def _load_upgrade_fn(filename: str):\n'
        '    if filename == "0353_channel_post_versions_hook_key.py":\n'
        '        return lambda: None  # 뮤테이션 — 마지막 파일만 조용히 no-op',
    )
    assert mutated_src != src, "치환 대상 문자열을 못 찾음 — 마이그 본문이 바뀐 것"

    tmp_dir = Path(tempfile.mkdtemp(prefix="3804-mutant-"))
    try:
        mig = _load_mutant(mutated_src, tmp_dir)
        engine = create_engine(prodlike_db)
        with pytest.raises(RuntimeError, match="channel_post_versions.hook_key"), engine.begin() as conn:
            ctx = MigrationContext.configure(conn)
            op_obj = Operations(ctx)
            import alembic.op as op_module
            op_module._proxy = op_obj
            mig.upgrade()
            # 예외가 이 지점까지 오지 못하지만(위에서 raise) — 만약 도달했다면 여기서
            # channel_connections(구간④ 초입 산출물, 0312)는 이미 생겨 있었을 것이다.
            # 이 사실은 커밋 전(롤백 전) 같은 트랜잭션 안에서만 관측 가능해 별도로
            # 남기지 않는다(RuntimeError가 hook_key를 정확히 지목했다는 사실 자체가
            # "초입만 보는 체크로는 못 잡는다"의 반증 — 만약 초입만 봤다면 애초에
            # channel_connections 존재만으로 skip 오판, 이 자리까지 못 왔다).
        engine.dispose()
    finally:
        import shutil

        shutil.rmtree(tmp_dir, ignore_errors=True)
