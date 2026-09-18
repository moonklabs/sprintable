"""story #3522(BE·위생, 페드루 PO 2026-09-06) — 마이그레이션 전용(raw SQL) CHECK
제약이 모델 `__table_args__`에 미러 안 돼 있으면 `Base.metadata.create_all()`
기반 로컬 테스트 DB가 그 제약 자체를 못 보는 «재료 불일치» 클래스(3516 승인
500 — PR#3871 — 의 뿌리 원인, PR#3871 본문 «범위 밖» 목록이 이 스토리의 출발점).

이 가드는 점 패치(9개 이름을 하드코딩해 하나씩 확인)가 아니라 **클래스 자체를
막는다** — 실제로 alembic upgrade head를 돌린 DB(정본)와 `Base.metadata.
create_all()`로 세운 DB(모델이 아는 전부)의 CHECK 제약 집합을 테이블별로
통째 대조한다. 어느 테이블에서든 한쪽에만 있는 CHECK가 생기면(신규 raw-SQL
전용 제약을 깜빡 미러 안 하거나, 반대로 모델에서 지운 걸 마이그에서 안 지운
경우 전부) 이 가드 하나가 잡는다 — 9개 목록에 없는 미래의 10번째도 잡는다.

**발견(디디, 2026-09-06)**: 스토리 본문·PR#3871이 나열한 9개 중
`ck_judgments_target_required_for_meta_kinds`는 실제로는 **10번째가 아니라
유령**이다 — 0214가 만들었지만 0218이 `upgrade()`에서 완전히 DROP하고
재생성하지 않았다(downgrade()에만 재생성 코드가 남아 있어 언뜻 "있는 것처럼"
보임). `psql \\d+`/`pg_constraint` 실측(아래 확인) 결과 이 이름은 현재 migrated
스키마에 없다 — 그래서 이 스토리가 실제로 미러하는 개수는 **8개**다. 이 사실
자체가 이 가드의 존재 이유를 한 번 더 증명한다(마이그 파일을 grep만 해서는
"생성됐다"와 "지금도 있다"를 못 가른다 — 실 DB 대조가 유일한 신뢰 소스).

`PARITY_TEST_DATABASE_URL`/`ALEMBIC_DATABASE_URL` 미설정 시 skip. 이 파일은
자체 전용 임시 DB를 만들어 `alembic upgrade head`를 돌리고 끝나면 지운다(공용
`_REAL_DB_URL` DB는 다른 테스트들이 create_all()로 이미 쓰고 있어 여기서 직접
마이그를 걸면 충돌한다).

**이 가드가 못 잡는 것(페드루 PO REQUIRED, 2026-09-06 — 가드는 스스로 뭘
놓치는지 선언해야 신뢰 가능하다)**: 대조는 **이름만**(`pg_constraint.conname`)
본다 — 마이그와 모델 양쪽에 같은 이름의 CHECK가 있기만 하면 통과하고, 그
안의 **조건식 자체가 서로 다르게 드리프트**해도(예: 마이그는 `IN ('a','b')`
인데 모델은 `IN ('a','b','c')`로 값 집합만 슬쩍 달라짐) 이 가드는 못 잡는다
— 이름 존재/부재 클래스(이 스토리의 실제 사고)만 겨눈 것이지 "제약 내용이
서로 정확히 같은 규칙을 표현하는가"까지 검증하는 게 아니다. 조건식 드리프트는
범위 밖(후속 스토리 대상)."""
from __future__ import annotations

import os
import subprocess
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine.url import make_url

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")
# story #3522(페드루 PO 실측 2026-09-06) — test_2643_no_raw_ddl_in_tests_guard.py::
# test_ac2_no_unmarked_raw_ddl_violations_across_test_suite는 모듈 `pytestmark`
# (리스트/단일 값)만 읽는다 — 함수 데코레이터(156/168/184행 @pytest.mark.
# destructive_schema)는 그 가드 눈에 안 보여, 이 파일의 헬퍼(118/127/138/152행
# CREATE/DROP DATABASE 리터럴)가 "raw DDL, destructive_schema 마커 없음"으로
# 오탐됐다. 모듈 pytestmark에 destructive_schema를 합류시킨다(함수 데코레이터
# 3개는 이제 중복이라 아래에서 뗀다).
pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="PARITY_TEST_DATABASE_URL/ALEMBIC_DATABASE_URL 미설정"),
]

_BACKEND_DIR = Path(__file__).parent.parent

# story #3522 — 스토리 본문 9개 중 `ck_judgments_target_required_for_meta_kinds`
# 는 유령(위 docstring 참고, 실제 8개). 이 5개 테이블(evidence·visual_artifacts·
# artifact_exports·billing_orders·platform_settings)을 __table_args__로 손대는
# 김에 같은 테이블에 있던 이름-패턴이 다른(raw sa.CheckConstraint 인라인) 4개도
# 같이 미러했다(billing_orders 3개·evidence 1개, psql 실측으로 이 5개 테이블
# 안에서는 이제 완전 대조 — 다른 테이블의 동종 드리프트는 스코프 밖).
_EXPECTED_MIRRORED = frozenset({
    "ck_evidence_type", "ck_evidence_work_item_type",
    "ck_visual_artifacts_source", "ck_artifact_exports_format",
    "ck_billing_orders_refund_status", "ck_billing_orders_purpose",
    "billing_orders_status_check", "billing_orders_currency_check", "billing_orders_amount_positive_check",
    "ck_platform_settings_dunning_grace_days_positive", "ck_platform_settings_vat_rate_bp_range",
    "ck_platform_settings_on_time_tolerance_seconds_nonneg",
})
_CONFIRMED_GHOST = "ck_judgments_target_required_for_meta_kinds"


def _sync_url(db_name: str) -> str:
    url = make_url(_REAL_DB_URL)
    url = url.set(database=db_name)
    if url.drivername.endswith("+asyncpg"):
        url = url.set(drivername="postgresql+psycopg2")
    elif url.drivername == "postgresql":
        url = url.set(drivername="postgresql+psycopg2")
    # 카디르 CI 발견(2026-09-06) — SQLAlchemy 2.x는 `str(URL)`에서 비밀번호를
    # `***`로 마스킹한다(repr 안전장치). 로컬(trust 인증·비번 없음)에선 우연히
    # 통과하고 CI(비번 있는 DB)에서만 인증 실패가 나던 이유 — 여기서 만든
    # URL은 로그로 안 나가고 subprocess env/엔진 접속에만 쓰이니 마스킹 해제가
    # 안전하다.
    return url.render_as_string(hide_password=False)


def _admin_engine():
    return create_engine(_sync_url("postgres"), isolation_level="AUTOCOMMIT")


def _run_alembic_upgrade_head(db_url: str) -> None:
    env = {**os.environ, "ALEMBIC_DATABASE_URL": db_url}
    result = subprocess.run(
        ["uv", "run", "alembic", "upgrade", "head"], cwd=_BACKEND_DIR, env=env,
        capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, f"alembic upgrade head 실패:\n{result.stdout}\n{result.stderr}"


def _check_constraints_by_table(db_url: str) -> dict[str, set[str]]:
    engine = create_engine(db_url)
    try:
        with engine.connect() as conn:
            rows = conn.execute(text(
                "SELECT conrelid::regclass::text AS table_name, conname "
                "FROM pg_constraint WHERE contype = 'c'"
            )).all()
    finally:
        engine.dispose()
    result: dict[str, set[str]] = {}
    for table_name, conname in rows:
        result.setdefault(table_name, set()).add(conname)
    return result


@pytest.fixture
def migrated_db_check_constraints():
    """전용 임시 DB에 실 alembic upgrade head를 돌려 CHECK 제약을 실측(정본)."""
    db_name = f"story3522_guard_migrated_{uuid.uuid4().hex[:12]}"
    admin = _admin_engine()
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    admin.dispose()
    db_url = _sync_url(db_name)
    try:
        _run_alembic_upgrade_head(db_url)
        yield _check_constraints_by_table(db_url)
    finally:
        admin = _admin_engine()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
        admin.dispose()


@pytest.fixture
def create_all_db_check_constraints():
    """전용 임시 DB에 Base.metadata.create_all()만 돌려 CHECK 제약을 실측(모델이
    아는 전부 — 로컬 destructive_schema 테스트 전부가 실제로 서는 스키마 그대로)."""
    db_name = f"story3522_guard_createall_{uuid.uuid4().hex[:12]}"
    admin = _admin_engine()
    with admin.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{db_name}"'))
    admin.dispose()
    db_url = _sync_url(db_name)
    try:
        from app.core.database import Base
        import app.models  # noqa: F401

        engine = create_engine(db_url)
        Base.metadata.create_all(engine)
        engine.dispose()
        yield _check_constraints_by_table(db_url)
    finally:
        admin = _admin_engine()
        with admin.connect() as conn:
            conn.execute(text(f'DROP DATABASE IF EXISTS "{db_name}" WITH (FORCE)'))
        admin.dispose()


def test_migrated_db_actually_lacks_the_confirmed_ghost_constraint(migrated_db_check_constraints):
    """양성대조(반대 방향) — `ck_judgments_target_required_for_meta_kinds`가
    진짜 유령인지(0218이 정말 안 되살렸는지) 이 테스트 자체가 실측으로 확인한다.
    이 assert가 언젠가 실패하면(다른 마이그가 이 제약을 되살렸으면) judgments.py
    모델에도 미러를 추가해야 한다는 신호."""
    all_conames = {name for names in migrated_db_check_constraints.values() for name in names}
    assert _CONFIRMED_GHOST not in all_conames, (
        f"{_CONFIRMED_GHOST}가 실제로 존재한다 — judgments.py 모델에도 미러를 추가할 것"
    )


def test_all_expected_check_constraints_mirrored_in_model(
    migrated_db_check_constraints, create_all_db_check_constraints,
):
    """뮤테이션 대상 — `_EXPECTED_MIRRORED` 12개(스토리 원안 9개 中 유령 1개 뺀
    8개 + 같은 테이블에서 추가 발견한 4개) 전부가 마이그 쪽에 실재하고,
    create_all() 쪽에도 정확히 같은 이름으로 있어야 한다. 모델에서 하나
    빼면(뮤테이션) 이 테스트가 RED."""
    migrated_all = {name for names in migrated_db_check_constraints.values() for name in names}
    create_all_all = {name for names in create_all_db_check_constraints.values() for name in names}

    for name in _EXPECTED_MIRRORED:
        assert name in migrated_all, f"{name}이 마이그 쪽에 없다(스토리 전제 자체가 무너짐)"
        assert name in create_all_all, f"{name}이 모델 __table_args__에 미러돼 있지 않다"


def test_check_constraint_diff_for_touched_tables_only(
    migrated_db_check_constraints, create_all_db_check_constraints,
):
    """이 스토리가 실제로 손댄 5개 테이블(evidence·visual_artifacts·
    artifact_exports·billing_orders·platform_settings)에 한정한 마이그↔모델
    대조 — 하나 빼면(뮤테이션) RED. `_EXPECTED_MIRRORED` 12개(스토리 본문 원안
    9개 中 실 8개 + 같은 테이블에서 psql 실측으로 추가 발견한 4개)가 이 5개
    테이블 CHECK의 전량이다.

    **스코프 경계(발견만, 새 착수 금지 — feedback_scope_stop_at_kickoff_
    boundary)**: 이 5개 테이블 밖으로 넓혀 전체 스키마를 대조해 보면(로컬에서
    1회 실측, 이 테스트엔 안 남김) 수십 개의 같은 클래스 드리프트가 더 나온다
    (`op.create_table()`의 컬럼/테이블 레벨 인라인 `sa.CheckConstraint` 인자로
    걸린 제약들 — 이번 스토리의 grep 방식(`create_check_constraint` 별도 호출만
    검색)으로는 안 잡히던 훨씬 큰 축). 그건 이 2pt 스토리의 스코프 밖 — PR
    본문에 "발견, 후속 스토리 필요"로만 남기고 여기서 고치지 않는다(스코프
    경계 규율)."""
    touched_tables = {"evidence", "visual_artifacts", "artifact_exports", "billing_orders", "platform_settings"}
    only_in_migrated: dict[str, set[str]] = {}
    only_in_create_all: dict[str, set[str]] = {}
    for table in touched_tables:
        migrated_names = migrated_db_check_constraints.get(table, set())
        create_all_names = create_all_db_check_constraints.get(table, set())
        diff_migrated = migrated_names - create_all_names
        diff_create_all = create_all_names - migrated_names
        if diff_migrated:
            only_in_migrated[table] = diff_migrated
        if diff_create_all:
            only_in_create_all[table] = diff_create_all

    assert not only_in_migrated, (
        f"마이그에만 있고 모델에 미러 안 된 CHECK — «재료 불일치» 재발: {only_in_migrated}"
    )
    assert not only_in_create_all, (
        f"모델에만 있고 마이그(실 DB)엔 없는 CHECK — 모델이 존재하지 않는 제약을 지어냄: {only_in_create_all}"
    )
