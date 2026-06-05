"""E-STANDUP 3b6b567c: org-level 재설계 — upsert shim + dedupe MERGE 회귀.

- shim: upsert 키 (project_id,author_id,date) → (org_id,author_id,date) 전환 검증(mock).
- dedupe lossless: real-DB(ALEMBIC_DATABASE_URL 있을 때) — 같은 (org,author,date) 복수
  project 엔트리(상이 plan) 시드 → dedupe SQL → 1엔트리·내용 0소실·링크 union·feedback
  reattach·lossy_rows=0·멱등. (마이그 0099 의 2a~2e 와 동형 SQL; dev migrate 재프로브는
  PR 본문에 별도 실증.)
"""
from __future__ import annotations

import os
import uuid
from datetime import date as _date
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


# ── shim 단위 (mock) ──────────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_upsert_keys_on_org_author_date_not_project():
    """org-level upsert: 기존 엔트리 조회 WHERE 에 project_id 가 빠지고 author_id+date 만."""
    from app.repositories.standup import StandupEntryRepository

    org = uuid.uuid4()
    repo = StandupEntryRepository(MagicMock(), org)
    repo.session = AsyncMock()
    existing_entry = MagicMock(); existing_entry.id = uuid.uuid4()
    sel_result = MagicMock(); sel_result.scalar_one_or_none.return_value = existing_entry
    repo.session.execute = AsyncMock(return_value=sel_result)
    repo.update = AsyncMock(return_value=existing_entry)

    await repo.upsert(
        project_id=uuid.uuid4(), author_id=uuid.uuid4(), date=_date(2026, 6, 5),
        done="d", plan="p", blockers=None, plan_story_ids=[],
    )

    # 첫 execute = SELECT (org-level 조회), 마지막 execute = link INSERT
    sel_sql = str(repo.session.execute.await_args_list[0].args[0])
    assert "author_id" in sel_sql and "date" in sel_sql
    assert "project_id =" not in sel_sql.replace("\n", " ")  # project_id 가 식별 키가 아님
    link_sql = str(repo.session.execute.await_args_list[-1].args[0])
    assert "standup_entry_projects" in link_sql  # link 유지


@pytest.mark.anyio
async def test_upsert_update_data_excludes_author_date_keeps_project():
    """update_data 에서 author_id/date(키)만 제외 — project_id(origin)는 갱신 대상 유지."""
    from app.repositories.standup import StandupEntryRepository

    repo = StandupEntryRepository(MagicMock(), uuid.uuid4())
    repo.session = AsyncMock()
    entry = MagicMock(); entry.id = uuid.uuid4()
    res = MagicMock(); res.scalar_one_or_none.return_value = entry
    repo.session.execute = AsyncMock(return_value=res)
    captured = {}
    async def _upd(_id, **data): captured.update(data); return entry
    repo.update = _upd

    pid = uuid.uuid4()
    await repo.upsert(project_id=pid, author_id=uuid.uuid4(), date=_date(2026, 6, 5), done="x", plan_story_ids=[])
    assert "author_id" not in captured and "date" not in captured
    assert captured.get("project_id") == pid
    assert captured.get("done") == "x"


# ── dedupe MERGE lossless (real-DB·skip-able) ─────────────────────────────────

_RAW = os.environ.get("PARITY_TEST_DATABASE_URL") or os.environ.get("ALEMBIC_DATABASE_URL") or ""
_ASYNC = _RAW.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
    "postgresql://", "postgresql+asyncpg://"
)

# 0099 upgrade 의 2a~2e 와 동형 (PARTITION (org,author,date)). 테스트가 unique index 를 잠시
# drop 후 dup 시드 → 이 SQL 실행 → 재생성.
_DEDUPE_SQL = [
    # 2a feedback reattach → keeper (先)
    """
    WITH ranked AS (
        SELECT id, row_number() OVER w AS rn, first_value(id) OVER w AS keeper
        FROM standup_entries
        WINDOW w AS (PARTITION BY org_id, author_id, date ORDER BY updated_at DESC, id DESC))
    UPDATE standup_feedback sf SET standup_entry_id = r.keeper
    FROM ranked r WHERE sf.standup_entry_id = r.id AND r.rn > 1
    """,
    # 2b keeper link union
    """
    WITH ranked AS (
        SELECT id, org_id, project_id, first_value(id) OVER w AS keeper
        FROM standup_entries
        WINDOW w AS (PARTITION BY org_id, author_id, date ORDER BY updated_at DESC, id DESC))
    INSERT INTO standup_entry_projects (id, entry_id, project_id, org_id)
    SELECT gen_random_uuid(), r.keeper, r.project_id, r.org_id FROM ranked r
    WHERE r.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM projects p WHERE p.id=r.project_id) ON CONFLICT (entry_id, project_id) DO NOTHING
    """,
    # 2d text MERGE + plan_story_ids union
    """
    WITH ranked AS (
        SELECT id, org_id, author_id, date,
               row_number() OVER w AS rn, first_value(id) OVER w AS keeper, count(*) OVER w AS cnt
        FROM standup_entries
        WINDOW w AS (PARTITION BY org_id, author_id, date ORDER BY updated_at DESC, id DESC)),
    keepers AS (
        SELECT k.id, k.org_id, k.author_id, k.date, k.done, k.plan, k.blockers
        FROM standup_entries k JOIN ranked r ON r.id = k.id WHERE r.rn = 1 AND r.cnt > 1)
    UPDATE standup_entries t SET
        plan = CASE WHEN sfx.plan_sfx = '' THEN t.plan ELSE COALESCE(t.plan,'') || sfx.plan_sfx END,
        plan_story_ids = COALESCE(sfx.psids, t.plan_story_ids)
    FROM keepers kp
    CROSS JOIN LATERAL (
        SELECT COALESCE((
            SELECT string_agg('\n\n--- merged from project: ' ||
                COALESCE(NULLIF(p.name,''), se2.project_id::text) || ' ---\n' || se2.plan,
                '' ORDER BY se2.updated_at DESC, se2.id DESC)
            FROM standup_entries se2 LEFT JOIN projects p ON p.id = se2.project_id
            WHERE se2.org_id=kp.org_id AND se2.author_id=kp.author_id AND se2.date=kp.date
              AND se2.id <> kp.id AND COALESCE(se2.plan,'')<>'' AND COALESCE(se2.plan,'')<>COALESCE(kp.plan,'')
        ), '') AS plan_sfx,
        (SELECT array_agg(DISTINCT x) FROM standup_entries se3, unnest(se3.plan_story_ids) AS x
         WHERE se3.org_id=kp.org_id AND se3.author_id=kp.author_id AND se3.date=kp.date) AS psids
    ) sfx WHERE t.id = kp.id
    """,
    # 2e 잉여행 DELETE (後)
    """
    WITH ranked AS (
        SELECT id, row_number() OVER (PARTITION BY org_id, author_id, date
               ORDER BY updated_at DESC, id DESC) AS rn FROM standup_entries)
    DELETE FROM standup_entries se USING ranked r WHERE se.id = r.id AND r.rn > 1
    """,
]


@pytest.mark.anyio
@pytest.mark.skipif(not _ASYNC, reason="real-DB URL 미설정 — skip")
async def test_dedupe_merge_lossless_and_idempotent_realdb():
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    org = uuid.uuid4(); author = uuid.uuid4(); d = _date(2026, 6, 5)
    p1, p2, p3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    e1, e2, e3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    fb = uuid.uuid4()
    eng = create_async_engine(_ASYNC)
    sm = async_sessionmaker(eng, expire_on_commit=False)
    try:
        async with sm() as s:
            # 격리: unique index 잠시 제거(테스트 dup 시드 허용)
            await s.execute(text("DROP INDEX IF EXISTS uq_standup_org_author_date"))
            for pid, nm in ((p1, "Alpha"), (p2, "Beta"), (p3, "Gamma")):
                await s.execute(text("INSERT INTO projects (id,org_id,name,created_at) VALUES (:i,:o,:n,now())"),
                                {"i": pid, "o": org, "n": nm})
            rows = [
                (e1, p1, "PLAN-ALPHA", "2026-06-05 10:00+00"),
                (e2, p2, "PLAN-BETA", "2026-06-05 11:00+00"),
                (e3, p3, "PLAN-GAMMA", "2026-06-05 12:00+00"),  # keeper(latest)
            ]
            for eid, pid, plan, ts in rows:
                await s.execute(text(
                    "INSERT INTO standup_entries (id,org_id,project_id,author_id,date,plan,plan_story_ids,created_at,updated_at)"
                    " VALUES (:i,:o,:p,:a,:d,:pl,ARRAY[]::uuid[],:t,:t)"),
                    {"i": eid, "o": org, "p": pid, "a": author, "d": d, "pl": plan, "t": ts})
                await s.execute(text(
                    "INSERT INTO standup_entry_projects (id,entry_id,project_id,org_id) VALUES (gen_random_uuid(),:e,:p,:o)"),
                    {"e": eid, "p": pid, "o": org})
            # feedback on 비-keeper(e1)
            await s.execute(text(
                "INSERT INTO standup_feedback (id,org_id,project_id,standup_entry_id,feedback_by_id,review_type,feedback_text,created_at,updated_at)"
                " VALUES (:i,:o,:p,:se,:fb,'comment','good',now(),now())"),
                {"i": fb, "o": org, "p": p1, "se": e1, "fb": uuid.uuid4()})
            await s.commit()

            async def run_dedupe():
                for sql in _DEDUPE_SQL:
                    await s.execute(text(sql))
                await s.commit()

            await run_dedupe()

            # 1엔트리만 남음 = keeper(e3)
            cnt = (await s.execute(text(
                "SELECT count(*) FROM standup_entries WHERE org_id=:o AND author_id=:a AND date=:d"),
                {"o": org, "a": author, "d": d})).scalar_one()
            assert cnt == 1
            keeper_plan = (await s.execute(text(
                "SELECT plan FROM standup_entries WHERE org_id=:o AND author_id=:a AND date=:d"),
                {"o": org, "a": author, "d": d})).scalar_one()
            # 내용 0 소실 — 세 plan 전부 보존
            assert "PLAN-GAMMA" in keeper_plan
            assert "PLAN-ALPHA" in keeper_plan and "Alpha" in keeper_plan  # provenance
            assert "PLAN-BETA" in keeper_plan and "Beta" in keeper_plan
            # 링크 union = {p1,p2,p3} 가 keeper 에
            links = set((await s.execute(text(
                "SELECT project_id FROM standup_entry_projects WHERE entry_id IN "
                "(SELECT id FROM standup_entries WHERE org_id=:o AND author_id=:a AND date=:d)"),
                {"o": org, "a": author, "d": d})).scalars().all())
            assert links == {p1, p2, p3}
            # feedback reattach → keeper(e3)
            fb_entry = (await s.execute(text("SELECT standup_entry_id FROM standup_feedback WHERE id=:i"),
                                        {"i": fb})).scalar_one()
            assert fb_entry == e3
            # lossy_rows = 0 재프로브(그룹 단일행 → dup 0)
            lossy = (await s.execute(text("""
                WITH ranked AS (SELECT id, row_number() OVER (PARTITION BY org_id,author_id,date) rn
                                FROM standup_entries WHERE org_id=:o AND author_id=:a AND date=:d)
                SELECT count(*) FROM ranked WHERE rn>1"""), {"o": org, "a": author, "d": d})).scalar_one()
            assert lossy == 0

            # 멱등: 재실행 무변화
            await run_dedupe()
            cnt2 = (await s.execute(text(
                "SELECT count(*) FROM standup_entries WHERE org_id=:o AND author_id=:a AND date=:d"),
                {"o": org, "a": author, "d": d})).scalar_one()
            assert cnt2 == 1
        # cleanup + unique index 복원
        async with sm() as s:
            await s.execute(text("DELETE FROM standup_feedback WHERE org_id=:o"), {"o": org})
            await s.execute(text("DELETE FROM standup_entry_projects WHERE org_id=:o"), {"o": org})
            await s.execute(text("DELETE FROM standup_entries WHERE org_id=:o"), {"o": org})
            await s.execute(text("DELETE FROM projects WHERE org_id=:o"), {"o": org})
            await s.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_standup_org_author_date "
                "ON standup_entries (org_id, author_id, date)"))
            await s.commit()
    finally:
        await eng.dispose()
