"""E-LOOP-LEDGER P1-S11: resolve_dispatch_context_pack 실 Postgres 검증(블루프린트 §2).

핵심: hypothesis→loop 1:0..N 관계에서 최신(created_at desc)·non-abandoned 1개만 선택되는지·
brief_doc_id 없는 loop은 None인지를 실 DB round-trip으로 직접 검증. 순수 wiring(payload/delivery
dict 조립)은 mock 테스트(test_e_loop_ledger_p1_s11_dispatch_context_pack.py)가 이미 커버 —
여기선 신규 SQL 쿼리 로직(정렬·필터)만 실 DB로 검증한다(resolve_dispatch_anchor의 실DB 검증이
별도 스모크로 분리된 것과 동형 관례).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_selects_most_recent_non_abandoned_loop_with_brief_doc_real_db():
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.models.doc import Doc
    from app.models.hypothesis import Hypothesis
    from app.models.loop import LoopRun
    from app.services.hypothesis import resolve_dispatch_context_pack

    engine, Session = await _session()
    org, project = uuid.uuid4(), uuid.uuid4()
    hyp_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    older_loop_id, newer_loop_id, abandoned_loop_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    older_doc_id, newer_doc_id = uuid.uuid4(), uuid.uuid4()

    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                Hypothesis(
                    id=hyp_id, org_id=org, project_id=project, owner_member_id=uuid.uuid4(),
                    statement="가설", metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
                    measure_after=now, status="active",
                ),
                Doc(id=older_doc_id, org_id=org, project_id=project, title="older brief", slug="older-brief",
                    content="## Context Pack\n\n오래된 브리핑."),
                Doc(id=newer_doc_id, org_id=org, project_id=project, title="newer brief", slug="newer-brief",
                    content="## Context Pack\n\n최신 브리핑."),
            ])
            await s.flush()
            s.add_all([
                LoopRun(id=older_loop_id, org_id=org, project_id=project, hypothesis_id=hyp_id,
                        title="older loop", created_by_member_id=uuid.uuid4(),
                        status="briefing", brief_doc_id=older_doc_id,
                        created_at=now - timedelta(days=2)),
                LoopRun(id=newer_loop_id, org_id=org, project_id=project, hypothesis_id=hyp_id,
                        title="newer loop", created_by_member_id=uuid.uuid4(),
                        status="briefing", brief_doc_id=newer_doc_id,
                        created_at=now - timedelta(days=1)),
                # 가장 최신이지만 abandoned → 제외돼야(older brief보다도 늦은데도 안 뽑힘).
                LoopRun(id=abandoned_loop_id, org_id=org, project_id=project, hypothesis_id=hyp_id,
                        title="abandoned loop", created_by_member_id=uuid.uuid4(),
                        status="abandoned", brief_doc_id=older_doc_id, created_at=now),
            ])
            await s.commit()

        async with Session() as s:
            out = await resolve_dispatch_context_pack(s, org, "hypothesis", hyp_id)
        assert out == "## Context Pack\n\n최신 브리핑."  # newer_loop(non-abandoned 중 최신) 선택.
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요(PARITY/ALEMBIC_DATABASE_URL)")
@pytest.mark.anyio
async def test_loop_without_brief_doc_id_returns_none_real_db():
    from sqlalchemy import text as _text
    from app.core.database import Base
    from app.models.hypothesis import Hypothesis
    from app.models.loop import LoopRun
    from app.services.hypothesis import resolve_dispatch_context_pack

    engine, Session = await _session()
    org, project = uuid.uuid4(), uuid.uuid4()
    hyp_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    try:
        async with Session() as s:
            await s.execute(_text("SET session_replication_role = replica"))
            s.add_all([
                Hypothesis(
                    id=hyp_id, org_id=org, project_id=project, owner_member_id=uuid.uuid4(),
                    statement="가설", metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
                    measure_after=now, status="active",
                ),
                LoopRun(id=uuid.uuid4(), org_id=org, project_id=project, hypothesis_id=hyp_id,
                        title="draft loop", created_by_member_id=uuid.uuid4(),
                        status="draft", brief_doc_id=None),
            ])
            await s.commit()

        async with Session() as s:
            out = await resolve_dispatch_context_pack(s, org, "hypothesis", hyp_id)
        assert out is None
    finally:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)
        await engine.dispose()
