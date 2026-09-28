"""story #4260 — 0406이 심은 부분 식 인덱스 `ix_activity_logs_site_post_published_version`((context->>'version_id') WHERE action =
'site_post_published')이 실제로 존재하고, 블로그 레시피 멘션의 «발행됨» 판정(#4256 · events.py `_open_site_draft_ids_for_work_item`)이 그
인덱스를 탈 수 있는 모양으로 쿼리를 보내는지 확認한다(0384 · test_4081과 같은 두 축).

① 인덱스 정의 · 같은 모양 쿼리가 Index/Bitmap Index Scan을 받는다(enable_seqscan=off — 후보 자체가 되는지).
② ⭐실제 함수를 불렀을 때 DB로 나가는 SQL에 JSON 키 'version_id'와 액션 값 'site_post_published'가 **리터럴**로 박혀 있다 — ORM bracket
   accessor · 파라미터 비교로 되돌아가면 generic plan에서 인덱스가 조용히 죽는다(에러 없음).
격리 로컬 throwaway realdb(alembic-migrated)만 사용 — 인덱스는 create_all이 아니라 마이그레이션이 만든다.
"""
from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

_RAW = os.environ.get("ALEMBIC_DATABASE_URL") or os.environ.get("PARITY_TEST_DATABASE_URL") or ""

pytestmark = pytest.mark.skipif(not _RAW, reason="real-DB URL 미설정 — skip")

_INDEX_NAME = "ix_activity_logs_site_post_published_version"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if _RAW.startswith(prefix):
            return "postgresql+asyncpg://" + _RAW[len(prefix):]
    return _RAW


@pytest.mark.anyio
async def test_index_exists_with_expected_definition():
    engine = create_async_engine(_async_url())
    try:
        async with engine.connect() as c:
            row = (await c.execute(text("select indexdef from pg_indexes where indexname = :n"), {"n": _INDEX_NAME})).scalar_one_or_none()
        assert row is not None, "0406 인덱스가 없다 — DB가 alembic heads인지 확인"
        assert "((context ->> 'version_id'::text))" in row, row
        assert "WHERE (action = 'site_post_published'::text)" in row, row
    finally:
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["custom", "generic"])
async def test_publish_log_lookup_shaped_query_uses_the_partial_index(mode):
    """같은 모양의 쿼리(액션 · JSON 키 리터럴)가 인덱스를 후보로 갖는다 — custom plan과 generic plan(파라미터 값 모름) 둘 다."""
    engine = create_async_engine(_async_url())
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as s:
            org_id = uuid.uuid4()
            await s.execute(text(
                "insert into activity_logs (id, org_id, actor_type, action, entity_type, entity_id, context) "
                "select gen_random_uuid(), :o, 'platform', case when g % 10 = 0 then 'site_post_published' else 'other_action' end, "
                "'site_post', gen_random_uuid(), jsonb_build_object('version_id', gen_random_uuid()::text) from generate_series(1, 1500) g"
            ), {"o": org_id})
            await s.execute(text("analyze activity_logs"))
            await s.execute(text("set local enable_seqscan = off"))
            await s.execute(text("set local plan_cache_mode = " + ("force_custom_plan" if mode == "custom" else "force_generic_plan")))
            sql = ("select 1 from activity_logs where activity_logs.org_id = :o and activity_logs.action = 'site_post_published' "
                   "and activity_logs.context->>'version_id' = :v")
            plan = "\n".join(r[0] for r in (await s.execute(text("explain " + sql), {"o": org_id, "v": str(uuid.uuid4())})).all())
            await s.rollback()
        assert _INDEX_NAME in plan, plan
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_real_call_emits_literal_json_key_and_action_not_params():
    """⭐실제 `_open_site_draft_ids_for_work_item`이 보내는 SQL을 가로채 — 'version_id' 키와 'site_post_published' 값이 리터럴로 박혀 있다."""
    from app.routers.events import _open_site_draft_ids_for_work_item

    engine = create_async_engine(_async_url())
    captured: list[str] = []

    def _capture(conn, cursor, statement, parameters, context, executemany):
        if "activity_logs" in statement:
            captured.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", _capture)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as s:
            await _open_site_draft_ids_for_work_item(s, org_id=uuid.uuid4(), payload={"work_item_id": str(uuid.uuid4())})
            await s.rollback()
        assert captured, "발행 로그 조회가 안 나갔다"
        sql = captured[-1]
        assert "->>'version_id'" in sql.replace(" ", ""), sql
        assert "'site_post_published'" in sql, sql
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", _capture)
        await engine.dispose()
