"""E-LOOP-LEDGER P1-S7: Context Pack 조립 실 Postgres 검증(블루프린트 §P1).

핵심: transition_loop(target='briefing')이 실제로 유사 hypothesis/loop embeddings를 검색해
Doc을 조립·loop.brief_doc_id에 stamp하는지(자기제외+outcome 재로드 포함)·Context Pack 조립이
예외를 던져도 loop 상태전이 자체는 절대 잃지 않는지(crux 핵심 불변식)를 round-trip으로 검증.

DB env(ALEMBIC_DATABASE_URL) 없으면 skip — 기존 alembic 마이그 스키마 전제(test_e_loop_ledger_
s22_status_transition.py와 동형, create_all 미사용).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)
pytestmark_db = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("77000000-0000-0000-0000-000000000001")
PROJECT = uuid.UUID("77000000-0000-0000-0000-000000000002")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed_org_project(s):
    for sql in [
        f"DELETE FROM embeddings WHERE org_id='{ORG}'",
        f"DELETE FROM loop_artifacts WHERE org_id='{ORG}'",
        f"DELETE FROM loop_runs WHERE org_id='{ORG}'",
        f"DELETE FROM hypotheses WHERE org_id='{ORG}'",
        f"DELETE FROM docs WHERE org_id='{ORG}'",
        f"DELETE FROM projects WHERE org_id='{ORG}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','C77','c77org','free')",
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJECT}','{ORG}','P77')",
    ]:
        await s.execute(text(sql))
    await s.commit()


@pytestmark_db
@pytest.mark.anyio
async def test_briefing_transition_assembles_doc_with_similar_history_and_excludes_self():
    from app.models.embedding import Embedding
    from app.models.hypothesis import Hypothesis
    from app.models.doc import Doc
    from app.models.loop import LoopRun
    from app.repositories.loop import LoopRunRepository
    from app.services.loop import transition_loop

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)

        past_hyp_id = uuid.uuid4()
        target_loop_id = uuid.uuid4()

        async with Session() as s:
            await s.execute(text("SET session_replication_role = replica"))
            s.add(Hypothesis(
                id=past_hyp_id, org_id=ORG, project_id=PROJECT, owner_member_id=uuid.uuid4(),
                statement="과거 온보딩 실험",
                metric_definition={"metric": "x", "source": "manual", "target": 1, "direction": "up"},
                measure_after=datetime.now(timezone.utc), status="verified",
                outcome_result={"hit": True},
            ))
            await s.flush()
            repo = LoopRunRepository(s, ORG)
            target_loop = await repo.create(
                project_id=PROJECT, title="신규 온보딩 loop", goal_tags=["onboarding"],
                status="draft", created_by_member_id=uuid.uuid4(),
            )
            target_loop_id = target_loop.id
            await s.flush()
            # 과거 hypothesis의 ready embedding(유사 이력) — 검색 대상.
            s.add(Embedding(
                id=uuid.uuid4(), org_id=ORG, project_id=PROJECT,
                entity_type="hypothesis", entity_id=past_hyp_id,
                embedding_text="과거 온보딩 실험", content_hash="h1",
                embedding=[0.9] + [0.0] * 767, model_version="m", dimension=768, status="ready",
            ))
            # target loop 자신의 embedding(이미 P1-S4 write-path가 만들었을 법한 것) — 자기 자신이라
            # 결과에서 제외돼야.
            s.add(Embedding(
                id=uuid.uuid4(), org_id=ORG, project_id=PROJECT,
                entity_type="loop", entity_id=target_loop_id,
                embedding_text="신규 온보딩 loop", content_hash="h2",
                embedding=[0.9] + [0.0] * 767, model_version="m", dimension=768, status="ready",
            ))
            await s.commit()

        async with Session() as s:
            loop_obj = await LoopRunRepository(s, ORG).get(target_loop_id)
            with patch("app.services.embedding_client.embed_text", return_value=[0.9] + [0.0] * 767):
                out = await transition_loop(s, ORG, loop_obj, "briefing")
            await s.commit()

        assert out.status == "briefing"
        assert out.brief_doc_id is not None

        async with Session() as s:
            doc = (await s.execute(select(Doc).where(Doc.id == out.brief_doc_id))).scalar_one()
            assert "과거 온보딩 실험" in doc.content
            assert "verified" in doc.content  # outcome 재로드 반영.
            assert "과거 유사 항목 1건" in doc.content  # target loop 자기 자신은 제외됐으므로 1건만.
            assert doc.project_id == PROJECT

            persisted_loop = (await s.execute(
                select(LoopRun).where(LoopRun.id == target_loop_id)
            )).scalar_one()
            assert persisted_loop.brief_doc_id == out.brief_doc_id
    finally:
        await eng.dispose()


async def _real_db_error_search(session, org_id, project_id, vector, limit=5):
    """실 Postgres 레벨 에러 재현(UndefinedTable) — 존재하지 않는 테이블 쿼리로 트랜잭션을
    server-level aborted 상태로 만든다. 순수 Python 예외(mock RuntimeError)와 달리 이 에러는
    같은 세션의 후속 쿼리까지 InFailedSqlTransactionError로 연쇄시킨다(까심 QA CRITICAL 재현
    시나리오와 동일 — SAVEPOINT 부재 시 session.commit()이 조용히 전체 롤백되는 근본 원인)."""
    await session.execute(text("SELECT * FROM this_table_definitely_does_not_exist_xyz"))
    return []  # 위에서 반드시 예외 — 도달 안 함.


@pytestmark_db
@pytest.mark.anyio
async def test_real_db_error_inside_savepoint_never_blocks_status_transition():
    """🔴까심 QA CRITICAL 회귀 — 비-tautological: 실 Postgres 에러(UndefinedTable)를 SAVEPOINT
    안에서 발생시켜, 이미 flush된 status='briefing' 전이가 DB에 실제로 persist되는지(draft로
    silent rollback 안 되는지) 직접 검증한다. mock RuntimeError는 이 시나리오를 재현 못 한다
    (Postgres 트랜잭션 상태에 영향이 없어 masking test — QA 지적 그대로 여기 회귀로 고정)."""
    from app.repositories.loop import LoopRunRepository
    from app.services.loop import transition_loop

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed_org_project(s)
            repo = LoopRunRepository(s, ORG)
            loop = await repo.create(
                project_id=PROJECT, title="실DB 장애 시나리오 loop", goal_tags=[],
                status="draft", created_by_member_id=uuid.uuid4(),
            )
            loop_id = loop.id
            await s.commit()

        async with Session() as s:
            loop_obj = await LoopRunRepository(s, ORG).get(loop_id)
            with patch("app.services.embedding_client.embed_text", return_value=[0.1] * 768):
                with patch(
                    "app.services.context_pack_search.search_similar_embeddings",
                    new=_real_db_error_search,
                ):
                    out = await transition_loop(s, ORG, loop_obj, "briefing")
            await s.commit()  # ⭐SAVEPOINT 없었다면 이 commit이 조용히 ROLLBACK됐을 지점.

        assert out.status == "briefing"  # in-memory 응답도 briefing.
        assert out.brief_doc_id is not None  # fallback Doc(embed_unavailable 취급)이 생성됨.

        async with Session() as s:
            from app.models.loop import LoopRun
            persisted = (await s.execute(select(LoopRun).where(LoopRun.id == loop_id))).scalar_one()
            # ⭐핵심 단정: 새 세션으로 재조회해도 실제 DB에 'briefing'이 persist돼 있어야 한다
            # (SAVEPOINT 부재 버그였다면 여기서 'draft'가 나와 거짓 성공을 잡아낸다).
            assert persisted.status == "briefing"
            assert persisted.brief_doc_id == out.brief_doc_id

            from app.models.doc import Doc
            doc = (await s.execute(select(Doc).where(Doc.id == out.brief_doc_id))).scalar_one()
            assert "일시 불가" in doc.content  # 검색 실패 → fallback 콘텐츠.
    finally:
        await eng.dispose()
