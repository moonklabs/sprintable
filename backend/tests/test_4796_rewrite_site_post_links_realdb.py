"""story 4796 — `scripts/jobs/rewrite_site_post_links.py` against a real Postgres: the report, the dry run and the rewrite of the origin prefix of `activity_logs.context.url` (action `site_post_published`).

The table is a minimal `activity_logs` (id, action, context jsonb) in a schema of its own, dropped afterwards; the job's SQL only reads and writes those columns.
Pinned: the report lists origins and counts only; a dry run writes nothing; the rewrite changes ONLY the leading origin of links that start with the old origin (path and query stay), only for the action
`site_post_published`, never a look-alike host or an origin that merely contains the old one, and a second run finds nothing; LIKE metacharacters in an origin are escaped; a bad origin is refused before any database work.
"""
from __future__ import annotations

import contextlib
import os
import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from scripts.jobs import rewrite_site_post_links as job

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

# not `destructive_schema`: the test only creates and drops a schema of its own and never touches `public` (a destructive file must be registered in infra/destructive-schema-shard-weights/)
pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
    pytest.mark.anyio,
]

OLD = "https://sprintable-backend-dev-787818285179.asia-northeast3.run.app"
OLD2 = "https://sprintable-backend-dev-57iommnikq-du.a.run.app"
NEW = "https://dev-api.sprintable.ai"


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL or ""
    for prefix in ("postgresql+psycopg2://", "postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


@contextlib.asynccontextmanager
async def _schema_session():
    """A session on an engine of its own, whose search_path is a fresh schema holding a minimal `activity_logs`; the schema is dropped afterwards."""
    schema = "t4796_" + uuid.uuid4().hex[:10]
    engine = create_async_engine(_async_url(), connect_args={"server_settings": {"search_path": schema}})
    try:
        async with engine.begin() as conn:
            await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
            await conn.execute(text(f'CREATE TABLE "{schema}".activity_logs (id uuid PRIMARY KEY, action text NOT NULL, context jsonb NOT NULL)'))
        async with AsyncSession(engine) as s:
            yield s
            await s.rollback()
    finally:
        async with engine.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await engine.dispose()


async def _add(session, action: str, url: str | None, *, extra: dict | None = None) -> uuid.UUID:
    import json

    ctx = {"gate_id": "g"} | ({"url": url} if url is not None else {}) | (extra or {})
    rid = uuid.uuid4()
    await session.execute(text("INSERT INTO activity_logs (id, action, context) VALUES (:id, :a, CAST(:c AS jsonb))"), {"id": rid, "a": action, "c": json.dumps(ctx)})
    return rid


async def _url(session, rid) -> str | None:
    return (await session.execute(text("SELECT context->>'url' FROM activity_logs WHERE id = :id"), {"id": rid})).scalar_one()


async def _seed(session):
    ids = {
        "a": await _add(session, "site_post_published", f"{OLD}/api/v2/public/site-posts/hello?public_key=pk_1&lang=ko"),
        "b": await _add(session, "site_post_published", f"{OLD}/api/v2/public/site-posts/second?public_key=pk_1&lang=en"),
        "old2": await _add(session, "site_post_published", f"{OLD2}/api/v2/public/site-posts/third?public_key=pk_2&lang=ko"),
        "already": await _add(session, "site_post_published", f"{NEW}/api/v2/public/site-posts/fourth?public_key=pk_3&lang=ko"),
        "custom": await _add(session, "site_post_published", "https://blog.customer.example/ko/blog/x"),
        "lookalike": await _add(session, "site_post_published", f"{OLD}.evil.example/api/v2/public/site-posts/x"),
        "contains": await _add(session, "site_post_published", f"https://proxy.example/?u={OLD}/api/v2/public/site-posts/x"),
        "other_action": await _add(session, "something_else", f"{OLD}/api/v2/public/site-posts/z"),
        "no_url": await _add(session, "site_post_published", None),
    }
    return ids


async def test_the_report_lists_origins_and_counts_only() -> None:
    async with _schema_session() as session:
        await _seed(session)
        rows = await job.counts_by_origin(session)
        assert dict(rows) == {OLD: 2, OLD2: 1, NEW: 1, "https://blog.customer.example": 1, f"{OLD}.evil.example": 1, "https://proxy.example": 1, None: 1}
        assert all(isinstance(o, (str, type(None))) and isinstance(n, int) for o, n in rows)
        assert not any("/api/" in (o or "") for o, _ in rows), "origins only, never a full link"


async def test_the_report_cuts_a_broken_link_without_a_path_at_the_query_so_it_prints_no_part_of_it() -> None:
    async with _schema_session() as session:
        await _add(session, "site_post_published", "https://broken.example?public_key=pk_secret&lang=ko")
        await _add(session, "site_post_published", "https://broken2.example#fragment")
        rows = dict(await job.counts_by_origin(session))
        assert rows == {"https://broken.example": 1, "https://broken2.example": 1}, rows


async def test_the_count_for_an_old_origin_matches_exactly_the_links_that_start_with_it() -> None:
    async with _schema_session() as session:
        await _seed(session)
        assert await job.count_with_origin(session, OLD) == 2
        assert await job.count_with_origin(session, OLD2) == 1
        assert await job.count_with_origin(session, "https://nobody.example") == 0


async def test_the_rewrite_changes_only_the_leading_origin_of_the_matching_links() -> None:
    async with _schema_session() as session:
        ids = await _seed(session)
        before_other = {k: await _url(session, v) for k, v in ids.items() if k not in ("a", "b")}
        n = await job.rewrite_origin(session, OLD, NEW)
        assert n == 2
        assert await _url(session, ids["a"]) == f"{NEW}/api/v2/public/site-posts/hello?public_key=pk_1&lang=ko", "path and query stay"
        assert await _url(session, ids["b"]) == f"{NEW}/api/v2/public/site-posts/second?public_key=pk_1&lang=en"
        assert {k: await _url(session, v) for k, v in ids.items() if k not in ("a", "b")} == before_other, "every other row is untouched (other origin, look-alike, contains, other action, no url)"
        row = (await session.execute(text("SELECT context FROM activity_logs WHERE id = :id"), {"id": ids["a"]})).scalar_one()
        assert row["gate_id"] == "g", "the rest of the context is kept"
        assert await job.rewrite_origin(session, OLD, NEW) == 0, "a second run finds nothing"


async def test_both_old_forms_can_be_rewritten_in_one_run_and_nothing_with_an_old_origin_is_left() -> None:
    async with _schema_session() as session:
        await _seed(session)
        assert await job.rewrite_origin(session, OLD, NEW) + await job.rewrite_origin(session, OLD2, NEW) == 3
        assert await job.count_with_origin(session, OLD) == 0 and await job.count_with_origin(session, OLD2) == 0


async def test_like_metacharacters_in_an_origin_are_escaped() -> None:
    async with _schema_session() as session:
        rid = await _add(session, "site_post_published", "https://a_b.example/x")
        other = await _add(session, "site_post_published", "https://aXb.example/x")
        assert await job.count_with_origin(session, "https://a_b.example") == 1
        assert await job.rewrite_origin(session, "https://a_b.example", NEW) == 1
        assert await _url(session, rid) == f"{NEW}/x" and await _url(session, other) == "https://aXb.example/x"
        pct = await _add(session, "site_post_published", "https://c%d.example/y")
        assert await job.count_with_origin(session, "https://c%d.example") == 1 and await _url(session, pct) == "https://c%d.example/y"


@pytest.mark.parametrize("bad", ["http://x.example", "https://x.example/path", "https://x.example/?q=1", "https://u:p@x.example", "x.example", "https://", "/", "https://x.example:abc", "https://x.example:99999"])
def test_a_bad_origin_is_refused_before_any_database_work(bad: str) -> None:
    with pytest.raises(SystemExit):
        job.check_origin(bad, what="--old-origin")


def test_the_origin_checks_normalise_and_accept_the_good_ones() -> None:
    assert job.check_origin(NEW + "/", what="--new-origin") == NEW
    assert job.check_origin("http://localhost:8000", what="--new-origin") == "http://localhost:8000"
    with pytest.raises(SystemExit):
        job.main(["--apply", "--new-origin", NEW])
    with pytest.raises(SystemExit):
        job.main(["--old-origin", OLD])  # a plan needs the new origin too



# ───────── run(): the dry-run / apply split, the commit and the exit code — the part the helper-level tests above do not reach ─────────

@contextlib.asynccontextmanager
async def _committed_schema(monkeypatch):
    """Like `_schema_session`, but the job's own sessions (the patched factory) see what is seeded: the rows are committed, the schema is dropped afterwards."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    schema = "t4796r_" + uuid.uuid4().hex[:10]
    engine = create_async_engine(_async_url(), connect_args={"server_settings": {"search_path": schema}})
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.begin() as conn:
            await conn.execute(text(f'CREATE SCHEMA "{schema}"'))
            await conn.execute(text(f'CREATE TABLE "{schema}".activity_logs (id uuid PRIMARY KEY, action text NOT NULL, context jsonb NOT NULL)'))
        monkeypatch.setattr("app.core.database.async_session_factory", factory)
        monkeypatch.setattr(job, "_db_url_summary", "test database")
        yield factory
    finally:
        async with engine.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await engine.dispose()


async def _seed_committed(factory):
    async with factory() as s:
        ids = await _seed(s)
        await s.commit()
    return ids


async def _read(factory, rid):
    async with factory() as s:
        return await _url(s, rid)


async def test_run_without_origins_is_a_read_only_report(monkeypatch, capsys) -> None:
    async with _committed_schema(monkeypatch) as factory:
        ids = await _seed_committed(factory)
        assert await job.run([], None, False) == 0
        out = capsys.readouterr().out
        assert f"{OLD}\t2" in out and f"{OLD2}\t1" in out and "/api/" not in out, out
        assert await _read(factory, ids["a"]) == f"{OLD}/api/v2/public/site-posts/hello?public_key=pk_1&lang=ko"


async def test_run_without_apply_is_a_plan_that_writes_nothing(monkeypatch, capsys) -> None:
    async with _committed_schema(monkeypatch) as factory:
        ids = await _seed_committed(factory)
        before = {k: await _read(factory, v) for k, v in ids.items()}
        assert await job.run([OLD, OLD2], NEW, False) == 0
        out = capsys.readouterr().out
        assert "dry run, nothing written" in out and "2 link(s)" in out and "1 link(s)" in out, out
        assert {k: await _read(factory, v) for k, v in ids.items()} == before, "a plan changes no row"


async def test_run_with_apply_rewrites_commits_and_exits_zero(monkeypatch, capsys) -> None:
    async with _committed_schema(monkeypatch) as factory:
        ids = await _seed_committed(factory)
        assert await job.run([OLD, OLD2], NEW, True) == 0
        assert "rewritten: 3; still with an old origin: 0" in capsys.readouterr().out
        # a session of its own (not the job's) sees it: the transaction was committed
        assert await _read(factory, ids["a"]) == f"{NEW}/api/v2/public/site-posts/hello?public_key=pk_1&lang=ko"
        assert await _read(factory, ids["old2"]) == f"{NEW}/api/v2/public/site-posts/third?public_key=pk_2&lang=ko"
        assert await _read(factory, ids["custom"]) == "https://blog.customer.example/ko/blog/x"
        assert await job.run([OLD, OLD2], NEW, True) == 0, "a second apply finds nothing and is still clean"


async def test_run_with_apply_exits_nonzero_when_something_with_an_old_origin_is_left(monkeypatch, capsys) -> None:
    """new == old: the rewrite 'succeeds' but the old origin is still there — the exit code must say so"""
    async with _committed_schema(monkeypatch) as factory:
        await _seed_committed(factory)
        assert await job.run([OLD], OLD, True) == 1
        assert "still with an old origin: 2" in capsys.readouterr().out


async def test_run_needs_the_new_origin_with_an_old_one(monkeypatch) -> None:
    async with _committed_schema(monkeypatch):
        with pytest.raises(SystemExit):
            await job.run([OLD], None, False)
