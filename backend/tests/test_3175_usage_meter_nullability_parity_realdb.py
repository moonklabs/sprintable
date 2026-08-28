"""story #3175(위생·BE) — usage_meters ORM↔실DB nullability 정합 회귀.

발견(PR#3575 qa:changes 수리 중, 2026-08-28): `app/models/usage_meter.py`의 `period_end`가
ORM에선 nullable=True인데 baseline 실DB는 NOT NULL(디폴트 없음, S48 도입 커밋부터 — 마이그
0건). ORM이 "DB가 거부할 행"을 합법으로 지어낼 수 있었다(커밋 시점까지 잠복하는
NotNullViolation). 정본 판별: DB가 정본(미터는 기간 필수, 실제 write 경로 0건이라 데이터
호환성 리스크 없음) — ORM을 nullable=False로 정렬. 같은 대조에서 created_at/updated_at이
ORM에 아예 없던 것도 발견(baseline엔 둘 다 DEFAULT now() NOT NULL로 실재) — 같이 채움.

이 테스트는 `information_schema.columns`를 실PG에서 직접 읽어 ORM 모델의 모든 컬럼과
nullable 여부를 1:1 대조한다 — 재발(제3의 컬럼이 또 갈리거나, period_end가 다시 갈라지는
경우) 시 컬럼 이름째 정확히 찍혀 빨강이 뜨도록."""
from __future__ import annotations

import os

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models.usage_meter import UsageMeter

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_usage_meters_orm_nullability_matches_live_db():
    engine = create_async_engine(_ASYNC)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with Session() as session:
            rows = (
                await session.execute(
                    text(
                        "SELECT column_name, is_nullable FROM information_schema.columns "
                        "WHERE table_schema='public' AND table_name='usage_meters'"
                    )
                )
            ).all()
            assert rows, "usage_meters 테이블이 실DB에 없음 — 대조 자체가 성립 안 됨"
            live_nullable = {r[0]: (r[1] == "YES") for r in rows}

            orm_columns = set(UsageMeter.__table__.columns.keys())
            live_columns = set(live_nullable.keys())

            # 형제 컬럼 일괄 대조 — ORM에 없는 실DB 컬럼(과거 created_at/updated_at처럼
            # 조용히 누락되는 클래스)이 있으면 정확히 그 이름으로 실패.
            missing_from_orm = live_columns - orm_columns
            assert not missing_from_orm, (
                f"ORM에 없는 실DB 컬럼: {missing_from_orm} — usage_meter.py에 매핑 추가 필요"
            )

            mismatches = []
            for col in UsageMeter.__table__.columns:
                if col.name not in live_nullable:
                    continue  # 위 missing_from_orm과 반대 방향(ORM만 있음)은 별도 정책 이슈, 이 테스트 범위 밖
                orm_nullable = col.nullable
                db_nullable = live_nullable[col.name]
                if orm_nullable != db_nullable:
                    mismatches.append(
                        f"{col.name}: ORM nullable={orm_nullable} vs DB nullable={db_nullable}"
                    )
            assert not mismatches, "nullability 드리프트: " + "; ".join(mismatches)
    finally:
        await engine.dispose()
