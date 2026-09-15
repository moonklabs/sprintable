"""story #3896(customer-zero·BE·테스트 위생) — Boolean NOT NULL 컬럼 server_default 정합
전수 회귀. test_3175_usage_meter_nullability_parity_realdb.py(단일 테이블·nullable 축)와
동형 패턴을 전 테이블·server_default 축으로 일반화.

발견(카디르 재QA, 2026-09-14): `app/models/user.py`의 `marketing_email_opt_out`이
migration 0286에선 `server_default=sa.false()`로 컬럼을 만들었는데 모델엔 Python-side
`default=False`만 있고 server_default가 없었다 — 이 모델 메타데이터로 테이블을 다시
만드는 테스트 경로(create_all 등)에서 실제로 DB 컬럼 default가 벗겨진다(alembic-migrated
DB는 정상인데 create_all 경로만 드리프트를 "실현"시키는 클래스, story #3175 usage_meter
사고와 같은 «ORM이 DB가 거부/변형할 상태를 합법으로 지어낼 수 있다» 계열).

이 테스트는 ORM 메타데이터(Base.metadata, 모든 등록 모델)를 훑어 Boolean·NOT NULL
컬럼 전수를 뽑고, 각 컬럼의 `server_default`가 실제 alembic-migrated DB의
`information_schema.columns.column_default`와 일치하는지 대조한다 — 제3의 컬럼이
드리프트하더라도 컬럼 이름째 정확히 찍혀 빨강이 뜨도록."""
from __future__ import annotations

import os

import pytest
from sqlalchemy import Boolean, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401 — Base.metadata에 전 모델 등록(import 부수효과, 기존 관례)
from app.core.database import Base

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


def _render_server_default(col) -> str | None:
    """server_default(DefaultClause)를 Postgres가 information_schema.columns.column_default
    로 돌려주는 것과 같은 모양(소문자 리터럴, 캐스트/따옴표 없음 — 실측 확認)의 문자열로
    렌더한다. server_default가 없으면 None(=DB에도 default가 없어야 정합)."""
    if col.server_default is None:
        return None
    arg = col.server_default.arg
    # story #3896 그라운딩(실측) — `server_default="false"`(이 코드베이스의 지배적 관례,
    # 예: member.py/pm.py/project_access.py)는 SQLAlchemy가 `.arg`를 raw 파이썬 문자열
    # 그대로 둔다(ClauseElement로 자동 래핑 안 함) — `sa.false()`/`text("false")`처럼
    # `.compile()`이 있는 ClauseElement인 경우만 컴파일한다.
    if isinstance(arg, str):
        compiled = arg
    else:
        compiled = str(arg.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    return compiled.strip().strip("'").lower()


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_boolean_not_null_server_default_matches_live_db():
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            mismatches: list[str] = []
            checked = 0
            for table in Base.metadata.tables.values():
                bool_not_null_cols = [
                    c for c in table.columns
                    if isinstance(c.type, Boolean) and not c.nullable
                ]
                if not bool_not_null_cols:
                    continue
                rows = (
                    await session.execute(
                        text(
                            "SELECT column_name, column_default FROM information_schema.columns "
                            "WHERE table_schema='public' AND table_name=:t"
                        ),
                        {"t": table.name},
                    )
                ).all()
                if not rows:
                    # 이 테이블 자체가 실DB에 없음(예: OSS 빌드에서 빠지는 ee 전용 테이블 등) —
                    # 테이블 존재 여부는 이 자의 관심사가 아니다(다른 가드의 몫), 조용히 skip.
                    continue
                live_default = {r[0]: r[1] for r in rows}
                for col in bool_not_null_cols:
                    checked += 1
                    if col.name not in live_default:
                        continue
                    db_val = live_default[col.name]
                    db_norm = db_val.strip().lower() if db_val is not None else None
                    orm_norm = _render_server_default(col)
                    if db_norm != orm_norm:
                        mismatches.append(
                            f"{table.name}.{col.name}: ORM server_default={orm_norm!r} "
                            f"vs DB column_default={db_norm!r}"
                        )
            assert checked > 0, "Boolean NOT NULL 컬럼을 하나도 못 찾음 — 대조 자체가 성립 안 됨"
            assert not mismatches, "server_default 드리프트: " + "; ".join(mismatches)
    finally:
        await engine.dispose()
