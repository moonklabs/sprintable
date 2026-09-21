"""story #4081(E-RECIPE-1 후속·성능, 까디르 #4455 QA 실측) — 0384 마이그가 심은
`ix_conversation_messages_event_lookup`(event_key·work_item_type·work_item_id·
created_at DESC, partial `... IS NOT NULL`)이 실제로 존재하고, `_find_existing_stage_
publish`(events.py, story #4075)·`get_event_publish_history`(#2665) 동형 쿼리가 그
인덱스를 Index/Bitmap Index Scan으로 타는지 EXPLAIN으로 직접 확認한다.

⚠️ 뮤테이션 pin — partial WHERE를 `metadata ? 'event'`(top-level 키 존재)로 되돌리면
Postgres 플래너가 이 인덱스를 후보로도 못 고른다(쿼리의 `->>` 등호 조건이 그 부분조건을
함의한다고 증명 못 함 — 0384 모듈 docstring 그라운딩 참조). 그 되돌림을 재현하면 이
파일의 두 EXPLAIN 테스트가 Seq Scan으로 RED가 된다.

#2864/#4080과 동일 정신 — 격리 로컬 throwaway realdb(alembic-migrated)만 사용."""
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

_INDEX_NAME = "ix_conversation_messages_event_lookup"

ORG = uuid.UUID("40810000-0000-0000-0000-000000000001")
PROJ = uuid.UUID("40810000-0000-0000-0000-0000000000c1")
CONV = uuid.UUID("40810000-0000-0000-0000-0000000000d1")


@pytest.fixture
def anyio_backend():
    return "asyncio"


async def _engine():
    eng = create_async_engine(_ASYNC)
    return eng, async_sessionmaker(eng, expire_on_commit=False)


async def _seed(s, *, n_event_rows: int = 1500) -> None:
    """org/project/conversation 1건 + event 메타 붙은 conversation_messages n건(플래너가
    작은 표에서도 인덱스를 실제로 고를 만큼의 행수 — 실측 확認: 50건 미만에서는 planner가
    seq scan을 더 싸게 봐 인덱스가 있어도 안 쓸 수 있다, 0384 그라운딩 5만 건 실측과
    같은 형이되 테스트는 훨씬 가볍게)."""
    for sql in [
        f"DELETE FROM conversation_messages WHERE conversation_id='{CONV}'",
        f"DELETE FROM conversations WHERE id='{CONV}'",
        f"DELETE FROM projects WHERE id='{PROJ}'",
        f"DELETE FROM organizations WHERE id='{ORG}'",
        f"INSERT INTO organizations (id,name,slug,plan) VALUES ('{ORG}','S4081','s4081-org','free')",
        f"INSERT INTO projects (id,org_id,name,slug,violation_level) VALUES "
        f"('{PROJ}','{ORG}','P','s4081-proj','warn')",
        f"INSERT INTO conversations (id,org_id,project_id,type,status) VALUES "
        f"('{CONV}','{ORG}','{PROJ}','group','open')",
    ]:
        await s.execute(text(sql))

    await s.execute(text(
        "INSERT INTO conversation_messages (id, conversation_id, content, mentioned_ids, "
        "reply_count, created_at, metadata, attachments) "
        "SELECT gen_random_uuid(), :conv, 'event message ' || g, ARRAY[]::uuid[], 0, "
        "now() - (g || ' seconds')::interval, "
        "jsonb_build_object('event', jsonb_build_object("
        "  'event_key', 'org.s4081' || (g % 5) || '.cycle',"
        "  'payload', jsonb_build_object("
        "    'work_item_type', 'story',"
        "    'work_item_id', ('40820000-0000-0000-0000-' || lpad(((g % 200))::text, 12, '0')),"
        "    'stage', (ARRAY['draft','research','review','publish'])[1 + (g % 4)]"
        "  )"
        ")), '[]'::jsonb "
        "FROM generate_series(1, :n) AS g"
    ), {"conv": CONV, "n": n_event_rows})
    await s.commit()
    await s.execute(text("ANALYZE conversation_messages"))
    await s.commit()


async def _explain_lines(s, sql: str, params: dict) -> list[str]:
    rows = (await s.execute(text(f"EXPLAIN (ANALYZE, BUFFERS) {sql}"), params)).all()
    return [r[0] for r in rows]


@pytest.mark.anyio
async def test_index_exists_with_expected_definition():
    """⭐AC3 — 0384가 심은 인덱스가 실물로 존재하고, partial WHERE가 IS NOT NULL 형태다
    (`?` 연산자로 되돌아가면 이 assert가 먼저 잡는다 — EXPLAIN 테스트보다 싼 조기경보)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            row = (await s.execute(text(
                "SELECT indexdef FROM pg_indexes WHERE indexname = :name AND tablename = 'conversation_messages'"
            ), {"name": _INDEX_NAME})).first()
        assert row is not None, f"{_INDEX_NAME} 인덱스가 없음"
        indexdef = row[0]
        assert "event_key" in indexdef
        assert "work_item_type" in indexdef
        assert "work_item_id" in indexdef
        assert "created_at" in indexdef
        assert "IS NOT NULL" in indexdef, (
            f"partial WHERE가 IS NOT NULL이 아님(`?` 연산자로 되돌아갔으면 플래너가 못 씀) — {indexdef!r}"
        )
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_find_existing_stage_publish_shaped_query_uses_index_not_seqscan():
    """⭐AC1/AC3 핵심 — `_find_existing_stage_publish`와 동형 4조건 쿼리가 Seq Scan이
    아니라 (Bitmap) Index Scan을 탄다. 뮤테이션 pin: partial WHERE를 `?`로 되돌리면
    이 테스트가 Seq Scan 재등장으로 RED."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            plan = "\n".join(await _explain_lines(s, (
                "SELECT cm.* FROM conversation_messages cm "
                "JOIN conversations c ON c.id = cm.conversation_id "
                "WHERE c.org_id = :org "
                "AND cm.metadata->'event'->>'event_key' = :ekey "
                "AND cm.metadata->'event'->'payload'->>'work_item_type' = 'story' "
                "AND cm.metadata->'event'->'payload'->>'work_item_id' = :wid "
                "AND cm.metadata->'event'->'payload'->>'stage' = 'draft' "
                "ORDER BY cm.created_at DESC LIMIT 1"
            ), {
                "org": ORG, "ekey": "org.s40812.cycle",
                "wid": "40820000-0000-0000-0000-000000000042",
            }))
        assert "Seq Scan on conversation_messages" not in plan, f"여전히 seq scan — plan:\n{plan}"
        assert "conversation_messages" in plan and "Index Scan" in plan, f"인덱스 스캔 흔적 없음 — plan:\n{plan}"
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_publish_history_shaped_query_reuses_same_index_leading_column():
    """⭐AC4 — publish-history(event_key 단일 조건)도 새 인덱스를 재사용한다(별도
    인덱스 불요, leading column만으로 매칭)."""
    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            plan = "\n".join(await _explain_lines(s, (
                "SELECT cm.* FROM conversation_messages cm "
                "JOIN conversations c ON c.id = cm.conversation_id "
                "WHERE c.org_id = :org "
                "AND cm.metadata->'event'->>'event_key' = :ekey "
                "ORDER BY cm.created_at DESC LIMIT 20"
            ), {"org": ORG, "ekey": "org.s40812.cycle"}))
        assert "Seq Scan on conversation_messages" not in plan, f"여전히 seq scan — plan:\n{plan}"
        assert _INDEX_NAME in plan, f"새 인덱스를 안 탐 — plan:\n{plan}"
    finally:
        await eng.dispose()
