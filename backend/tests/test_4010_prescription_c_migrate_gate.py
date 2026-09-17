"""story #4010 — `scripts/jobs/check_and_apply_prescription_c.py` + `migrate.sh` 배선 검증.

prod 승격이 main 전용 0354(down_revision="0295")를 develop 원본 0354(down_revision=
"0353")로 교체하면, prod DB(alembic_version="0354")에 `alembic upgrade heads`를 그대로
돌리면 0282·0288·0291·0296~0353(60개)이 "이미 지난 조상"으로 오판돼 조용히 스킵된다
(doc a4fe633e "처방 C 게이트 스크립트" 리허설이 확인한 사고 클래스). 이 파일은 그
처방을 migrate.sh 안에 판별형으로 통합한 게이트 스크립트를 실측 검증한다.

## main 역사적 상태를 재현하는 방법(AC3ⓐ 픽스처)
main의 옛 재봉합 파일(0283 down=0281·0289 down=0287·0292 down=0290·0354 down=0295)은
이번 승격에서 develop 원본으로 전부 교체돼 이 코드베이스 어디에도 남아있지 않다 —
그래서 "main 파일셋 스냅샷"을 별도로 레포에 넣는 대신(AC3 본문이 허용하는 대안),
**현재 codebase의 리비전 모듈을 직접 순서대로 invoke**해서 그 역사적 상태를 재현한다:
0001~0281은 정상 `alembic upgrade 0281`(이 구간은 main/develop 분기 이전이라 안전),
그 뒤 0283~0295를 ORPHAN_SKIPS(0282·0288·0291) 3개만 건너뛰고 하나씩 직접 invoke,
마지막에 0354를 직접 invoke(0354는 org_members/users/members만 읽어 60개 스킵분에
의존하지 않는다 — 그라운딩 확認), `alembic_version`을 "0354"로 직접 UPDATE. 이 절차
자체가 이 파일의 첫 픽스처 테스트(`test_fixture_reproduces_main_historical_state`)로
스스로 검증된다.

`PARITY_TEST_DATABASE_URL`/`ALEMBIC_DATABASE_URL` 미설정 시 skip. `destructive_schema`
마커 — 전용 임시 DB를 만들어 쓰고 끝나면 지운다(공용 realdb 오염 방지, test_3522/
test_f6d1bbaa와 동일 관례)."""
from __future__ import annotations

import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import make_url

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL 미설정"),
]

_BACKEND_DIR = Path(__file__).parent.parent
_GATE_SCRIPT = _BACKEND_DIR / "scripts" / "jobs" / "check_and_apply_prescription_c.py"
_MIGRATE_SH = _BACKEND_DIR / "scripts" / "migrate.sh"

sys.path.insert(0, str(_BACKEND_DIR / "scripts" / "jobs"))
import check_and_apply_prescription_c as gate  # noqa: E402


def _sync_url(db_name: str) -> str:
    url = make_url(_REAL_DB_URL)
    url = url.set(database=db_name)
    if url.drivername.endswith("+asyncpg"):
        url = url.set(drivername="postgresql+psycopg2")
    elif url.drivername == "postgresql":
        url = url.set(drivername="postgresql+psycopg2")
    return url.render_as_string(hide_password=False)


def _admin_engine():
    return create_engine(_sync_url("postgres"), isolation_level="AUTOCOMMIT")


def _create_db(db_name: str) -> None:
    admin = _admin_engine()
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    admin.dispose()


def _drop_db(db_name: str) -> None:
    admin = _admin_engine()
    with admin.connect() as conn:
        conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
    admin.dispose()


def _run_alembic(db_url: str, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "ALEMBIC_DATABASE_URL": db_url}
    return subprocess.run(
        ["uv", "run", "alembic", *args], cwd=_BACKEND_DIR, env=env,
        capture_output=True, text=True, timeout=180,
    )


def _run_gate(db_url: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "ALEMBIC_DATABASE_URL": db_url}
    return subprocess.run(
        [sys.executable, str(_GATE_SCRIPT)], cwd=_BACKEND_DIR, env=env,
        capture_output=True, text=True, timeout=180,
    )


def _build_main_historical_fixture(db_url: str) -> None:
    """AC3ⓐ 픽스처 — main이 실제로 도달해 있던 상태(alembic_version="0354", 60개
    스킵분 물리 미적용)를 이 codebase만으로 재현. 모듈 docstring 참고."""
    r = _run_alembic(db_url, "upgrade", "0281")
    assert r.returncode == 0, r.stderr

    from alembic.config import Config
    from alembic.operations import Operations
    from alembic.runtime.migration import MigrationContext
    from alembic.script import ScriptDirectory

    cfg = Config(str(_BACKEND_DIR / "alembic.ini"))
    script = ScriptDirectory.from_config(cfg)
    sequence = [rev for rev in (f"{i:04d}" for i in range(283, 296)) if rev not in gate.ORPHAN_SKIPS]
    sequence.append(gate.ANCHOR_VERSION)

    engine = create_engine(db_url)
    with engine.begin() as conn:
        ctx = MigrationContext.configure(conn)
        with Operations.context(ctx):
            for rev_id in sequence:
                rev = script.get_revision(rev_id)
                rev.module.upgrade()
        conn.execute(text("UPDATE alembic_version SET version_num = :v"), {"v": gate.ANCHOR_VERSION})
    engine.dispose()


def _schema_only_dump(db_url: str) -> str:
    url = make_url(db_url)
    env = {**os.environ, "PGPASSWORD": url.password or ""}
    result = subprocess.run(
        [
            "pg_dump", "--schema-only", "--no-owner", "--no-privileges",
            "-h", url.host or "localhost", "-p", str(url.port or 5432),
            "-U", url.username or "postgres", "-d", url.database,
        ],
        env=env, capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, result.stderr
    # \restrict/\unrestrict 라인은 pg_dump 세션마다 랜덤 토큰이라 항상 다르다(doc
    # a4fe633e 리허설 결과 "세션 토큰 2줄 제외"와 동일 관례) — 비교 전 제거.
    return "\n".join(
        line for line in result.stdout.splitlines()
        if not line.startswith("\\restrict") and not line.startswith("\\unrestrict")
    )


@pytest.fixture
def two_scratch_dbs():
    suffix = uuid.uuid4().hex[:10]
    main_db = f"story4010_main_{suffix}"
    dev_db = f"story4010_dev_{suffix}"
    _create_db(main_db)
    _create_db(dev_db)
    try:
        yield _sync_url(main_db), _sync_url(dev_db)
    finally:
        _drop_db(main_db)
        _drop_db(dev_db)


@pytest.fixture
def scratch_db():
    db_name = f"story4010_{uuid.uuid4().hex[:12]}"
    _create_db(db_name)
    try:
        yield _sync_url(db_name)
    finally:
        _drop_db(db_name)


# ============================================================================
# REPLAY_SET 구성 근거 — 그래프에서 재계산해 대조(페드루 PO 검토, 2026-09-17 12:01Z).
# ============================================================================

def test_replay_set_is_exactly_60():
    assert len(gate.REPLAY_SET) == 60


def test_replay_set_contiguous_part_matches_graph_computed_value():
    """0296~0353(57개, 0352는 결번)은 develop 그래프에서 STAMP_TARGET(0353)의 조상을
    CONTIGUOUS_LOWER_BOUND(0295) 미포함으로 walk한 값과 정확히 같아야 한다 — 하드코딩
    값이 그래프와 따로 놀면(리비전 재넘버·삽입 등) 이 테스트가 잡는다."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    cfg = Config(str(_BACKEND_DIR / "alembic.ini"))
    script = ScriptDirectory.from_config(cfg)
    computed = sorted(
        rev.revision for rev in script.iterate_revisions(gate.STAMP_TARGET, gate.CONTIGUOUS_LOWER_BOUND)
    )
    expected_contiguous = sorted(set(gate.REPLAY_SET) - set(gate.ORPHAN_SKIPS))
    assert computed == expected_contiguous


def test_replay_set_orphans_are_real_ancestors_of_contiguous_lower_bound():
    """ORPHAN_SKIPS(0282·0288·0291)는 "main이 실제로 건너뛴 값"이라는 역사적 사실
    자체는 그래프만으론 복원 불가(main의 옛 재봉합 파일이 이제 없음)하지만, 적어도
    "develop 그래프상 유효한 자리"(CONTIGUOUS_LOWER_BOUND의 조상)인지는 검증 가능 —
    오타·조작 리비전 id가 아님을 고정."""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    cfg = Config(str(_BACKEND_DIR / "alembic.ini"))
    script = ScriptDirectory.from_config(cfg)
    ancestors_of_bound = {
        rev.revision for rev in script.iterate_revisions(gate.CONTIGUOUS_LOWER_BOUND, "base")
    }
    for orphan in gate.ORPHAN_SKIPS:
        assert orphan in ancestors_of_bound, (
            f"{orphan}이 CONTIGUOUS_LOWER_BOUND({gate.CONTIGUOUS_LOWER_BOUND})의 develop "
            "그래프상 조상이 아니다 — REPLAY_SET 구성이 깨졌다."
        )


def test_replay_set_has_zero_non_transactional_ddl_operations():
    """페드루 PO 검토②(2026-09-17) — REPLAY_SET 60개 파일에 CONCURRENTLY·autocommit_block·
    isolation_level 변경이 0건이어야 한 트랜잭션으로 전부 묶어도 안전하다."""
    forbidden = ("CONCURRENTLY", "autocommit_block", "isolation_level")
    offenders = []
    for rev_id in gate.REPLAY_SET:
        matches = list((_BACKEND_DIR / "alembic" / "versions").glob(f"{rev_id}_*.py"))
        assert len(matches) == 1, f"{rev_id}: {len(matches)}개 매치(1개여야 함)"
        content = matches[0].read_text(encoding="utf-8")
        for token in forbidden:
            if token in content:
                offenders.append(f"{matches[0].name}::{token}")
    assert not offenders, f"REPLAY_SET에 비트랜잭션 연산 발견: {offenders}"


# ============================================================================
# migrate.sh 배선 순서 — 처방 C는 0183a fork precheck 뒤 · stamp-chain-integrity 앞.
# ============================================================================

def test_migrate_sh_places_prescription_c_between_fork_precheck_and_integrity_guard():
    content = _MIGRATE_SH.read_text(encoding="utf-8")
    fork_idx = content.index("prod-fork precheck: no action needed")
    gate_idx = content.index("check_and_apply_prescription_c.py")
    integrity_idx = content.index("check_stamp_chain_integrity.py")
    assert fork_idx < gate_idx < integrity_idx, (
        "처방 C 게이트는 0183a fork precheck 뒤·stamp-chain-integrity 정합 가드 앞에 "
        "있어야 한다(정합 가드가 처방 C보다 먼저 돌면 60개 누락 그대로 FAIL한다)."
    )


def test_migrate_sh_has_no_secrets_or_db_url_echo():
    """AC5 — migrate.sh 어디에도 ALEMBIC_DATABASE_URL 값 자체를 echo/print하는 라인이
    없어야 한다(다른 precheck들도 이미 이 관례를 지킨다 — 처방 C 스텝도 예외 없음)."""
    content = _MIGRATE_SH.read_text(encoding="utf-8")
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        assert "$ALEMBIC_DATABASE_URL" not in stripped, f"DB URL을 그대로 출력하는 라인 발견: {stripped!r}"


# ============================================================================
# AC1/AC3 — 실측 시나리오 ⓐⓑⓒ.
# ============================================================================

def test_fixture_reproduces_main_historical_state(scratch_db):
    """픽스처 자체의 자기검증 — main 역사적 상태(alembic_version="0354", 60개 스킵분
    물리 미적용)를 정확히 재현했는지, 처방 C를 아직 안 돌린 시점에 확인."""
    _build_main_historical_fixture(scratch_db)
    engine = create_engine(scratch_db)
    with engine.connect() as conn:
        current = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert current == "0354"
        # ORPHAN_SKIPS 중 하나(vat_rate_bp)의 컬럼이 아직 없어야 한다 — 물리 미적용 확認.
        has_col = conn.execute(text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name='platform_settings' AND column_name='vat_rate_bp'"
        )).scalar()
        assert has_col is None, "픽스처가 이미 vat_rate_bp를 갖고 있다 — 재현 실패"
    engine.dispose()


def test_ac3a_main_anchor_db_replayed_then_heads_matches_develop_fresh(two_scratch_dbs):
    main_db, dev_db = two_scratch_dbs

    _build_main_historical_fixture(main_db)

    gate_result = _run_gate(main_db)
    assert gate_result.returncode == 0, gate_result.stderr
    assert "REPLAY 완료" in gate_result.stdout

    engine = create_engine(main_db)
    with engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == gate.STAMP_TARGET
    engine.dispose()

    heads_result = _run_alembic(main_db, "upgrade", "heads")
    assert heads_result.returncode == 0, heads_result.stderr

    dev_fresh_result = _run_alembic(dev_db, "upgrade", "heads")
    assert dev_fresh_result.returncode == 0, dev_fresh_result.stderr

    integrity = subprocess.run(
        [sys.executable, "scripts/jobs/check_stamp_chain_integrity.py"],
        cwd=_BACKEND_DIR, env={**os.environ, "ALEMBIC_DATABASE_URL": main_db},
        capture_output=True, text=True, timeout=60,
    )
    assert integrity.returncode == 0, integrity.stderr

    assert _schema_only_dump(main_db) == _schema_only_dump(dev_db), (
        "처방 C 재생 후 스키마가 develop fresh와 다르다(diff 0이어야 함, doc a4fe633e 리허설 결과)"
    )


def test_ac3b_develop_fresh_db_is_noop(scratch_db):
    r = _run_alembic(scratch_db, "upgrade", "heads")
    assert r.returncode == 0, r.stderr

    engine = create_engine(scratch_db)
    with engine.connect() as conn:
        before = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
    engine.dispose()

    gate_result = _run_gate(scratch_db)
    assert gate_result.returncode == 0, gate_result.stderr
    assert "no-op" in gate_result.stdout

    engine = create_engine(scratch_db)
    with engine.connect() as conn:
        after = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
    engine.dispose()
    assert before == after, "develop-fresh DB인데 no-op 판정 뒤 alembic_version이 바뀜"


def test_ac3c_rerun_after_replay_is_noop(two_scratch_dbs):
    """AC2 멱등성 — 처방 C가 이미 한 번 성공한 뒤 같은 잡이 재실행돼도(예: Cloud Run
    잡 재시도) 두 번째 실행은 반드시 no-op."""
    main_db, _dev_db = two_scratch_dbs
    _build_main_historical_fixture(main_db)

    first = _run_gate(main_db)
    assert first.returncode == 0, first.stderr
    assert "REPLAY 완료" in first.stdout

    second = _run_gate(main_db)
    assert second.returncode == 0, second.stderr
    assert "no-op" in second.stdout
    assert "REPLAY" not in second.stdout, "두 번째 실행이 재생을 또 시도함 — 멱등성 위반"


# ============================================================================
# AC2 — 실패 시 안전(부분 적용 0건) + fail-closed.
# ============================================================================

def test_ac2_partial_failure_rolls_back_and_does_not_stamp(scratch_db, monkeypatch):
    """REPLAY 도중 실패하면 트랜잭션 전체 롤백 — 이미 성공한 앞쪽 revision의 DDL도
    같이 사라지고 alembic_version도 ANCHOR_VERSION 그대로여야 한다(부분 적용 0건)."""
    _build_main_historical_fixture(scratch_db)

    # REPLAY_SET 중간의 한 revision이 실패하도록 alembic.ini 없는 잘못된 cwd로 유도하는
    # 대신, 실제로 모듈을 실행 시점에 실패시키기 위해 존재하지 않는 revision을 하나
    # REPLAY_SET에 끼워 넣은 임시 리스트로 gate.main()을 직접 호출(subprocess 대신
    # in-process — monkeypatch가 subprocess 경계를 못 넘어가므로).
    broken_set = gate.REPLAY_SET[:30] + ["9999zzzz"] + gate.REPLAY_SET[30:]
    monkeypatch.setattr(gate, "REPLAY_SET", broken_set)

    os.environ["ALEMBIC_DATABASE_URL"] = scratch_db
    try:
        # get_revision()이 존재하지 않는 id에 CommandError를 던진다(RuntimeError보다
        # 먼저 걸림) — 어느 예외든 전파되기만 하면 이 테스트의 관심사(부분 적용 0건)는
        # 충족된다.
        with pytest.raises(Exception, match="9999zzzz"):
            gate.main()
    finally:
        del os.environ["ALEMBIC_DATABASE_URL"]

    engine = create_engine(scratch_db)
    with engine.connect() as conn:
        current = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        assert current == gate.ANCHOR_VERSION, "실패했는데 stamp가 진행됨 — 부분 적용 위험"
        # 앞쪽 30개 중 하나(0282, vat_rate_bp)도 롤백돼 있어야 한다(부분 적용 0건).
        has_col = conn.execute(text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name='platform_settings' AND column_name='vat_rate_bp'"
        )).scalar()
        assert has_col is None, "실패했는데 앞쪽 revision의 DDL이 남아있다 — 트랜잭션 롤백 실패"
    engine.dispose()


def test_fail_closed_on_unknown_current_revision(scratch_db):
    """페드루 PO 검토①(2026-09-17) — 현재 stamp가 ANCHOR_VERSION도 아니고 develop
    그래프에도 없는 미지의 값이면 no-op이 아니라 잡을 실패시켜야 한다."""
    r = _run_alembic(scratch_db, "upgrade", "0281")
    assert r.returncode == 0, r.stderr
    engine = create_engine(scratch_db)
    with engine.connect() as conn:
        conn.execute(text("UPDATE alembic_version SET version_num = 'totally_unknown_rev'"))
        conn.commit()
    engine.dispose()

    gate_result = _run_gate(scratch_db)
    assert gate_result.returncode == 1, "미지의 리비전인데 잡이 성공(no-op)했다 — fail-closed 위반"
    assert "FAIL-CLOSED" in gate_result.stderr

    engine = create_engine(scratch_db)
    with engine.connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar() == "totally_unknown_rev"
    engine.dispose()


# ============================================================================
# AC5 — 로그에 시크릿·DB URL 출력 0.
# ============================================================================

def test_ac5_no_secrets_or_db_url_in_gate_output(scratch_db):
    r = _run_alembic(scratch_db, "upgrade", "heads")
    assert r.returncode == 0, r.stderr
    gate_result = _run_gate(scratch_db)
    combined = gate_result.stdout + gate_result.stderr
    url = make_url(scratch_db)
    if url.password:
        assert url.password not in combined
    assert "ALEMBIC_DATABASE_URL=" not in combined
    assert "postgresql" not in combined.lower()
