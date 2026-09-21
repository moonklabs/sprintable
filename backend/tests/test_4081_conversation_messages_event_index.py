"""story #4081(E-RECIPE-1 후속·성능, 까디르 #4455 QA 실측) — 0384 마이그가 심은
`ix_conversation_messages_event_lookup`(event_key·work_item_type·work_item_id·
created_at DESC, partial `... IS NOT NULL`)이 실제로 존재하고, `_find_existing_stage_
publish`(events.py, story #4075)·`get_event_publish_history`(#2665)가 실제로 그
인덱스를 타는지 확認한다.

⛔story #4081 2차 정정(디디군 크로스세션 그라운딩, PO 릴레이) — 1차 버전은 손으로 쓴
raw SQL(`->` 체인, 리터럴 키)로만 검증했는데, 그게 **실제로 BE가 도는 경로가 아니었다**.
`ConversationMessage.msg_metadata["event"]["event_key"]`(ORM bracket accessor)는 JSON
키 자체를 **bind parameter**로 컴파일한다(`.compile()` 실측: `metadata[$1][$2] ->> $3`,
literal_binds 없이는 'event'/'payload'/'work_item_id' 전부 파라미터) — 표현식 인덱스는
리터럴 키에 고정돼 있어, PostgreSQL이 이 statement를 generic plan으로 돌리면(`EXPLAIN
(GENERIC_PLAN)`로 PG16 로컬 재현 — asyncpg가 같은 커넥션에서 반복 실행하면 자동 전환
가능한 자리) 파라미터 키 값을 모르니 인덱스가 후보에도 못 올라 Seq Scan으로 조용히
되돌아간다(에러 없음 — `?` vs `IS NOT NULL` 사고와 같은 클래스, 이번엔 다른 축).

처방(events.py 본문): JSON 키를 `text()`로 SQL에 직접 리터럴 박고(코드 고정 상수라
인젝션 위험 없음), 비교 **값**만 bind parameter로 남긴다. 아래 두 테스트 그룹:
  ① 인덱스 자체가 이 정확한 리터럴-키 표현식 형태를 Index/Bitmap Index Scan으로
     받아들이는지(raw SQL, 인덱스 정의 검증).
  ② ⭐핵심 — 실제 `_find_existing_stage_publish`/`get_event_publish_history`를 그대로
     호출했을 때 DB로 나가는 진짜 SQL을 SQLAlchemy 이벤트로 가로채, JSON 키가 더 이상
     bind parameter가 아니라 리터럴로 박혀 있는지 직접 확認한다 — "잰 물건이 실 쿼리가
     아니었다"는 재발을 막는 자리(디디군 own 재발방지 습관과 동형).

⚠️ 뮤테이션 pin — ①의 partial WHERE를 `metadata ? 'event'`로 되돌리면 ①이 Seq Scan
재등장으로 RED. events.py를 다시 `.msg_metadata["event"][...]` bracket accessor로
되돌리면 ②가 "리터럴 키 없음"으로 RED(실측 확認 後 원복 예정).

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


# ─── ① 인덱스 자체 — 리터럴-키 표현식 형태를 받아들이는지(raw SQL) ─────────────────


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
    """⭐AC1/AC3 — `_find_existing_stage_publish`가 실제로 내는(events.py 수정 後) 리터럴-키
    형태 4조건 쿼리가 Seq Scan이 아니라 (Bitmap) Index Scan을 탄다. 뮤테이션 pin: partial
    WHERE를 `?`로 되돌리면 이 테스트가 Seq Scan 재등장으로 RED."""
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


# ─── ② 핵심 — 실제 코드 경로가 진짜로 리터럴 키를 내는지(파라미터화 재발 방지) ──────────


@pytest.mark.anyio
async def test_find_existing_stage_publish_real_call_emits_literal_json_keys_not_params():
    """⭐⭐story #4081 2차 정정의 핵심 pin — `_find_existing_stage_publish`를 실제로
    호출했을 때 DB로 나가는 진짜 SQL을 가로채(SQLAlchemy `before_cursor_execute` 이벤트),
    JSON 키('event'·'payload'·'work_item_type'·'work_item_id'·'stage'·'event_key')가
    파라미터가 아니라 SQL 문자열에 리터럴로 박혀 있는지 직접 확認한다. 이게 실측으로
    증명하는 유일한 방법 — raw SQL 손동작 테스트는 "잰 물건이 실 쿼리가 아니다"라는
    이번 재발 클래스를 구조적으로 못 잡는다.

    뮤테이션 pin: events.py를 `.msg_metadata["event"]["event_key"].astext == ...`
    bracket accessor로 되돌리면 캡처된 SQL에 이 리터럴들이 사라지고 파라미터 자리표시자
    (`$1`/`%(...)s`)만 남아 이 테스트가 RED가 된다."""
    from sqlalchemy import event as sa_event

    from app.routers.events import _find_existing_stage_publish

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)

            captured: list[str] = []

            def _capture(conn, cursor, statement, parameters, context, executemany):
                if "conversation_messages" in statement and "metadata" in statement:
                    captured.append(statement)

            sa_event.listen(eng.sync_engine, "before_cursor_execute", _capture)
            try:
                await _find_existing_stage_publish(
                    s, org_id=ORG, definition_key="org.s40812.cycle",
                    work_item_type="story", work_item_id="40820000-0000-0000-0000-000000000042",
                    stage="draft",
                )
            finally:
                sa_event.remove(eng.sync_engine, "before_cursor_execute", _capture)

        assert captured, "_find_existing_stage_publish가 DB 쿼리를 하나도 안 냄(seed/함수 시그니처 확認)"
        stmt = captured[-1]
        for literal in ("'event'", "'payload'", "'event_key'", "'work_item_type'", "'work_item_id'", "'stage'"):
            assert literal in stmt, (
                f"JSON 키 {literal}가 SQL 리터럴로 안 박혀 있음(파라미터로 샌 것으로 의심) — statement:\n{stmt}"
            )
    finally:
        await eng.dispose()


@pytest.mark.anyio
async def test_get_event_publish_history_real_call_emits_literal_json_keys_not_params():
    """위 테스트와 동형 — `get_event_publish_history`(publish-history 엔드포인트)도 같은
    처방을 받았는지 실호출로 확認."""
    from sqlalchemy import event as sa_event

    from app.dependencies.auth import AuthContext
    from app.routers.events import get_event_publish_history

    eng, Session = await _engine()
    try:
        async with Session() as s:
            await _seed(s)
            # org admin/owner 게이트 — org owner 시드.
            await s.execute(text(
                "INSERT INTO org_members (id, org_id, user_id, role) VALUES "
                "(gen_random_uuid(), :org, gen_random_uuid(), 'owner')"
            ), {"org": ORG})
            user_id = (await s.execute(text(
                "SELECT user_id FROM org_members WHERE org_id = :org AND role = 'owner' LIMIT 1"
            ), {"org": ORG})).scalar_one()
            await s.commit()

            captured: list[str] = []

            def _capture(conn, cursor, statement, parameters, context, executemany):
                if "conversation_messages" in statement and "metadata" in statement:
                    captured.append(statement)

            sa_event.listen(eng.sync_engine, "before_cursor_execute", _capture)
            try:
                await get_event_publish_history(
                    definition_key="org.s40812.cycle", limit=20,
                    db=s, auth=AuthContext(user_id=str(user_id), email=None, claims={}, org_id=str(ORG)),
                    org_id=ORG,
                )
            finally:
                sa_event.remove(eng.sync_engine, "before_cursor_execute", _capture)

        assert captured, "get_event_publish_history가 DB 쿼리를 하나도 안 냄"
        stmt = captured[-1]
        assert "'event'" in stmt and "'event_key'" in stmt, (
            f"JSON 키가 SQL 리터럴로 안 박혀 있음(파라미터로 샌 것으로 의심) — statement:\n{stmt}"
        )
    finally:
        await eng.dispose()
