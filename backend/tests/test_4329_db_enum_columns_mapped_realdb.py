"""story #4329 — DB에서 PG enum인 컬럼은 모델도 같은 이름 · 같은 값의 `Enum`으로 매핑해야 한다.

실사고: `meetings.meeting_type`은 DB enum인데 모델이 `Text`라 ORM이 varchar로 보내 `POST /api/v2/meetings` · `?meeting_type=`가
`meeting_type = character varying`으로 500이었다. 모델↔DB drift 감사(`scripts/model_db_drift_audit.py`)는 타입을 비교하지 않아
못 잡았고, 기존 realdb 테스트는 raw SQL 캐스트로 심어 ORM 경로를 안 탔다.
"""
from __future__ import annotations

import os

import pytest
import sqlalchemy as sa

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


def enum_mapping_gaps(db_enum_columns: list[tuple[str, str, str, list[str]]], metadata: sa.MetaData) -> list[str]:
    """(테이블, 컬럼, enum 이름, 값들) 중 모델이 같은 이름 · 같은 값의 `Enum`으로 매핑하지 않은 것."""
    gaps = []
    for table, column, enum_name, labels in db_enum_columns:
        mt = metadata.tables.get(table)
        if mt is None or column not in mt.c:
            continue  # 모델에 없는 테이블 · 컬럼은 drift 감사의 몫
        ty = mt.c[column].type
        if not isinstance(ty, sa.Enum):
            gaps.append(f"{table}.{column}: DB enum {enum_name} · 모델 {type(ty).__name__}")
        elif ty.name != enum_name or list(ty.enums) != labels:
            gaps.append(f"{table}.{column}: DB {enum_name}{labels} · 모델 {ty.name}{list(ty.enums)}")
    return gaps


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
def test_every_db_enum_column_is_mapped_as_the_same_enum():
    import app.models  # noqa: F401 — 전 모델 등록
    from app.core.database import Base

    engine = sa.create_engine(_REAL_DB_URL.replace("postgresql+asyncpg://", "postgresql+psycopg2://"))
    try:
        with engine.connect() as conn:
            rows = conn.execute(sa.text(
                "SELECT c.table_name, c.column_name, t.typname, array_agg(e.enumlabel ORDER BY e.enumsortorder) "
                "FROM information_schema.columns c "
                "JOIN pg_type t ON t.typname = c.udt_name AND t.typtype = 'e' "
                "JOIN pg_enum e ON e.enumtypid = t.oid "
                "WHERE c.table_schema = 'public' "
                "GROUP BY c.table_name, c.column_name, t.typname"
            )).all()
    finally:
        engine.dispose()
    columns = [(t, c, n, list(labels)) for t, c, n, labels in rows]
    assert any(t == "meetings" and c == "meeting_type" for t, c, _n, _l in columns), "스캔이 실제로 DB enum 컬럼을 읽는지(공허 통과 방지)"
    assert enum_mapping_gaps(columns, Base.metadata) == []


def test_control_a_text_mapped_enum_column_is_caught():
    md = sa.MetaData()
    sa.Table("m", md, sa.Column("kind", sa.Text), sa.Column("tier", sa.Enum("a", "b", name="tier")), sa.Column("x", sa.Enum("a", name="other")))
    cols = [("m", "kind", "kind_enum", ["a"]), ("m", "tier", "tier", ["a", "b"]), ("m", "x", "x_enum", ["a"])]
    assert enum_mapping_gaps(cols, md) == ["m.kind: DB enum kind_enum · 모델 Text", "m.x: DB x_enum['a'] · 모델 other['a']"]
