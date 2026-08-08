"""story #2191 — GET /api/v2/docs 일반 분기(list())가 무커서였다. FE는 이미 cursor 를
보내고 있었으나(ApiDocRepository.list()) BE list_docs 가 그 파라미터를 라우터·리포 어느 층
에서도 안 받아 조용히 버려졌다(#2230 의 거울상 — 이번엔 서버가 «못 알아듣는» 쪽). #2231
정본 규약 A(limit+1 오버페치 + has_more/next_cursor body meta, 참조 구현:
conversations.py::list_messages)를 적용한다.

정렬 기준은 created_at/updated_at 이 아니라 Doc.sort_order(기본값 0, 수동 재배치 안 하면
전부 동률)다 — sort_order 단독으로는 페이지 경계에서 행이 씹히므로 (sort_order,id) 복합
커서를 쓴다. 이 테스트는 «전부 sort_order=0인 흔한 실제 상황»에서 두 번째 페이지가 첫
페이지와 겹치지 않고, 전체를 순회하면 원본과 정확히 일치하는 것을 실 PG로 증명한다
(#2231 AC3 요구사항 — 200 응답만으로 갈음 금지).
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

ORG = uuid.UUID("d2191000-0000-0000-0000-000000000010")
PROJ = uuid.UUID("d2191000-0000-0000-0000-000000000011")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _clean(s):
    for sql in [
        f"DELETE FROM docs WHERE project_id='{PROJ}'",
        f"DELETE FROM projects WHERE id='{PROJ}'",
    ]:
        await s.execute(text(sql))
    await s.commit()


async def _seed_all_sort_order_zero(s, n: int) -> list[uuid.UUID]:
    """n건 전부 sort_order=0(디폴트, 실제 대다수 케이스) — 동률 상황에서 id 2차키로
    페이지 경계가 깨지지 않는 것이 이 테스트의 핵심."""
    await _clean(s)
    await s.execute(text(
        f"INSERT INTO projects (id,org_id,name) VALUES ('{PROJ}','{ORG}','P2191')"
    ))
    ids = []
    for i in range(n):
        did = uuid.uuid4()
        ids.append(did)
        await s.execute(text(
            f"INSERT INTO docs (id,org_id,project_id,title,slug,content,sort_order) VALUES "
            f"('{did}','{ORG}','{PROJ}','doc-{i}','doc-{i}-{did.hex[:8]}','',0)"
        ))
    await s.commit()
    return ids


@pytest.mark.anyio
async def test_second_page_no_overlap_and_full_union_matches_realdb():
    from app.routers.docs import list_docs
    from app.repositories.doc import DocRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            seeded_ids = set(await _seed_all_sort_order_zero(s, n=5))

        collected: set[uuid.UUID] = set()
        cursor = None
        pages_fetched = 0
        total_rows_seen = 0
        async with Session() as s:
            repo = DocRepository(s, ORG)
            while True:
                pages_fetched += 1
                assert pages_fetched <= 10, "무한루프 방지 — has_more가 계속 True로 나오면 커서 전진 실패"
                page = await list_docs(
                    project_id=PROJ, parent_id=None, doc_type=None, tags=None, slug=None, q=None,
                    ids=None, limit=2, cursor=cursor, repo=repo,
                )
                page_ids = {d.id for d in page["data"]}
                overlap = page_ids & collected
                assert not overlap, f"페이지 간 겹침 발생 — 커서가 안 전진함: {overlap}"
                collected |= page_ids
                total_rows_seen += len(page["data"])
                if not page["meta"]["has_more"]:
                    assert page["meta"]["next_cursor"] is None
                    break
                cursor = page["meta"]["next_cursor"]
                assert cursor is not None

        assert seeded_ids == collected, "전 페이지 합집합이 원본과 정확히 일치해야 한다(누락·중복 0)"
        assert total_rows_seen == 5
        assert pages_fetched == 3  # limit=2로 5건 → 2+2+1
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_no_cursor_under_limit_has_more_false_realdb():
    """음성대조 — 총량이 limit 이하면 has_more=False·next_cursor=None."""
    from app.routers.docs import list_docs
    from app.repositories.doc import DocRepository

    eng, Session = await _engine()
    try:
        async with Session() as s:
            seeded_ids = await _seed_all_sort_order_zero(s, n=3)

        async with Session() as s:
            repo = DocRepository(s, ORG)
            page = await list_docs(
                project_id=PROJ, parent_id=None, doc_type=None, tags=None, slug=None, q=None,
                ids=None, limit=50, cursor=None, repo=repo,
            )
        assert {d.id for d in page["data"]} == set(seeded_ids)
        assert page["meta"]["has_more"] is False
        assert page["meta"]["next_cursor"] is None
    finally:
        await eng.dispose()
