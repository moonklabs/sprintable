"""b13352c2 codex finding②: cascade void 스코핑 realdb lock(mock 무의미 보완).

`void_pending_doc_gate` 의 WHERE(org_id·work_item_id·work_item_type='doc'·gate_type='doc_approval'·
status='pending')를 **negative 케이스**로 잠근다 — authz-critical(우회 cascade)이라 스코핑 1개라도 빠지면
타 gate 를 잘못 void(권한 우회). 매칭 게이트만 void·나머지(타 gate_type·타 work_item_type·terminal·타 doc·
cross-org)는 무접촉. DB env 없으면 skip(CI alembic-fresh).
"""
from __future__ import annotations

import os
import uuid

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.core.database import Base
    import app.models  # noqa: F401
    import app.models.participation  # noqa: F401
    import app.models.workflow_line  # noqa: F401
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


def _gate(org, wi, *, wit, gt, status):
    from app.models.gate import Gate
    return Gate(id=uuid.uuid4(), org_id=org, work_item_id=wi, work_item_type=wit,
                gate_type=gt, status=status)


@pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요")
@pytest.mark.anyio
async def test_void_pending_doc_gate_scoping_locked():
    from sqlalchemy import select

    from app.models.gate import Gate
    from app.services.gate_service import void_pending_doc_gate

    orgA, orgB = uuid.uuid4(), uuid.uuid4()
    d1, d2, d3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()  # uq(org,work_item,type,gate_type)=1 → 차원별 別 doc
    engine, Session = await _session()
    try:
        async with Session() as s:
            # 비-status 차원: match 와 정확히 1 차원만 다른 negative(같은 d1). uq 때문에 status 차원은
            # 같은 키에 2행 불가 → terminal 은 자기 doc(d3)에 두고 그 doc 을 void 시도해 status 필터 격리(아래).
            cases = {
                "match": _gate(orgA, d1, wit="doc", gt="doc_approval", status="pending"),     # → VOID
                "merge": _gate(orgA, d1, wit="doc", gt="merge", status="pending"),            # gate_type만 다름
                "wrongtype": _gate(orgA, d1, wit="story", gt="doc_approval", status="pending"),  # work_item_type만
                "otherdoc": _gate(orgA, d2, wit="doc", gt="doc_approval", status="pending"),   # work_item_id만
                "crossorg": _gate(orgB, d1, wit="doc", gt="doc_approval", status="pending"),   # org만
                "terminal": _gate(orgA, d3, wit="doc", gt="doc_approval", status="approved"),  # status만(자기 doc d3)
            }
            for g in cases.values():
                s.add(g)
            await s.flush()
            ids = {k: g.id for k, g in cases.items()}

            voided = await void_pending_doc_gate(s, orgA, d1, uuid.uuid4())
            assert voided is True  # 매칭(orgA·d1·doc·doc_approval·pending) void 수행
            # status 차원 격리: terminal 의 자기 doc(d3) 을 void 시도 → status='pending' 필터로 no-op(False)·
            # terminal 무접촉. status 필터 제거 시 이 호출이 terminal 을 void → 아래 assert 가 잡음.
            voided_terminal = await void_pending_doc_gate(s, orgA, d3, uuid.uuid4())
            assert voided_terminal is False  # terminal(approved)은 pending 아님 → no-op

            statuses = {r.id: r.status for r in (await s.execute(select(Gate))).scalars().all()}
        # 매칭만 voided.
        assert statuses[ids["match"]] == "voided", "매칭 doc_approval pending gate 미void"
        # 나머지 전부 무접촉(스코핑 누수 시 잘못 void) — 각 스코핑 차원 1개씩 잠금.
        for k in ("merge", "wrongtype", "otherdoc", "crossorg", "terminal"):
            assert statuses[ids[k]] != "voided", f"{k} 가 잘못 void됨(스코핑 누수·authz 우회)"
    finally:
        await engine.dispose()
