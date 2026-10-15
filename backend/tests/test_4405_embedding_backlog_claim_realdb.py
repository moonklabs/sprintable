"""story #4405 — embedding_backlog: claim(짧은 tx · processing 표시) → 커밋 → embed(tx 없이) → 행마다 짧은 tx 기록.

실 PG여야 하는 이유: 행 잠금 · SKIP LOCKED · 두 세션 동시성은 mock으로 재현되지 않는다.

- embed 도중 다른 세션의 같은 행 UPDATE가 막히지 않는다(예전: 배치 전체를 FOR UPDATE로 쥔 채 embed → lock_timeout).
- 워커 둘이 겹쳐도 같은 행 embed는 한 번(story #2461이 막으려던 유료 Vertex 중복 호출 0).
- lease: 15분 지난 processing은 다시 고르고, 살아 있는 claim(방금 찍힌 processing)은 안 고른다.
- embed 도중 글이 바뀌면(enqueue가 pending · 새 hash로 되돌림) 옛 벡터를 버린다.
- poison-pill: 5회째 실패면 failed · terminal, 다음 판에 안 고른다.
"""
from __future__ import annotations

import asyncio
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]

_VECTOR = [0.1] * 768


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _async_url() -> str:
    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix):]
    return url


async def _session_factory():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    import app.models  # noqa: F401 — 전 모델 메타데이터 로드
    from app.core.database import Base

    engine = create_async_engine(_async_url())
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _seed(Session, texts, *, status="pending", retry_count=0, updated_at=None):
    from app.models.embedding import Embedding
    from app.models.organization import Organization
    from app.models.project import Project
    from app.services.embedding_enqueue import _content_hash

    async with Session() as s:
        org = Organization(id=uuid.uuid4(), name="Org", slug=f"org-{uuid.uuid4().hex[:8]}")
        s.add(org)
        await s.commit()
        project = Project(id=uuid.uuid4(), org_id=org.id, name="Project")
        s.add(project)
        await s.commit()
        rows = []
        for text in texts:
            row = Embedding(
                id=uuid.uuid4(), org_id=org.id, project_id=project.id, entity_type="loop",
                entity_id=uuid.uuid4(), embedding_text=text, content_hash=_content_hash(text),
                status=status, retry_count=retry_count,
            )
            if updated_at is not None:
                row.updated_at = updated_at
            s.add(row)
            rows.append(row)
        await s.commit()
        return org.id, project.id, rows


async def _get(Session, row_id):
    from sqlalchemy import select

    from app.models.embedding import Embedding

    async with Session() as s:
        return (await s.execute(select(Embedding).where(Embedding.id == row_id))).scalar_one()


class _BlockingEmbed:
    """첫 호출에서 멈춰 서서 테스트가 «embed 도중»에 끼어들 수 있게 한다. 호출한 글을 센다."""

    def __init__(self, block_first=True):
        self.calls: list[str] = []
        self.started = threading.Event()
        self.release = threading.Event()
        self._block_first = block_first
        self._lock = threading.Lock()

    def __call__(self, text):
        with self._lock:
            self.calls.append(text)
            first = len(self.calls) == 1
        if first and self._block_first:
            self.started.set()
            assert self.release.wait(20), "테스트가 embed를 풀어 주지 않음"
        return _VECTOR

    async def wait_started(self):
        assert await asyncio.to_thread(self.started.wait, 20), "embed가 시작되지 않음"


@pytest.mark.anyio
async def test_other_session_update_is_not_blocked_while_embedding():
    """embed 도중 다른 세션이 같은 행을 UPDATE — lock_timeout 2초 안에 끝난다(예전 구조는 배치를 FOR UPDATE로 쥔 채 기다려 RED)."""
    from sqlalchemy import text

    from app.services.embedding_backlog import process_embedding_backlog

    engine, Session = await _session_factory()
    try:
        _, _, rows = await _seed(Session, ["a", "b"])
        fake = _BlockingEmbed()
        with patch("app.services.embedding_client.embed_text", side_effect=fake):
            async with Session() as worker:
                task = asyncio.create_task(process_embedding_backlog(worker))
                await fake.wait_started()
                try:
                    async with Session() as other:
                        await other.execute(text("SET LOCAL lock_timeout = '2s'"))
                        for row in rows:
                            await other.execute(
                                text("UPDATE embeddings SET error_message = 'touched' WHERE id = :id"), {"id": row.id},
                            )
                        await other.commit()
                finally:
                    fake.release.set()
                    summary = await task
        assert sorted(summary["embedded"]) == sorted(str(r.id) for r in rows)
        for row in rows:
            assert (await _get(Session, row.id)).status == "ready"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_overlapping_workers_embed_each_row_once():
    """워커 A가 embed 도중일 때 워커 B가 한 판 — B는 A가 claim한 행을 안 고른다(processing). 전체 embed 호출 = 행 수."""
    from app.services.embedding_backlog import process_embedding_backlog

    engine, Session = await _session_factory()
    try:
        _, _, rows = await _seed(Session, ["x", "y", "z"])
        fake = _BlockingEmbed()
        with patch("app.services.embedding_client.embed_text", side_effect=fake):
            async with Session() as worker_a:
                task_a = asyncio.create_task(process_embedding_backlog(worker_a))
                await fake.wait_started()
                try:
                    async with Session() as worker_b:
                        summary_b = await process_embedding_backlog(worker_b)
                finally:
                    fake.release.set()
                    summary_a = await task_a
        assert summary_b["scanned"] == 0
        assert summary_a["scanned"] == 3
        assert sorted(fake.calls) == ["x", "y", "z"]  # 중복 embed 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_expired_lease_is_reclaimed_but_live_claim_is_not():
    """processing인데 updated_at이 15분 넘게 지났으면 죽은 워커 — 다시 고른다. 1분 전 claim은 살아 있는 워커 — 안 고른다."""
    from app.services.embedding_backlog import process_embedding_backlog

    engine, Session = await _session_factory()
    try:
        now = datetime.now(timezone.utc)
        _, _, stale = await _seed(Session, ["stale"], status="processing", updated_at=now - timedelta(minutes=20))
        _, _, live = await _seed(Session, ["live"], status="processing", updated_at=now - timedelta(minutes=1))
        fake = _BlockingEmbed(block_first=False)
        with patch("app.services.embedding_client.embed_text", side_effect=fake):
            async with Session() as worker:
                summary = await process_embedding_backlog(worker)
        assert fake.calls == ["stale"]
        assert summary["embedded"] == [str(stale[0].id)]
        assert (await _get(Session, stale[0].id)).status == "ready"
        assert (await _get(Session, live[0].id)).status == "processing"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_claim_stamps_updated_at_so_the_lease_starts_now():
    """claim이 updated_at을 지금으로 찍는다 — 오래된 pending 행(updated_at 1시간 전)을 claim한 직후 다른 워커가 lease 만료로 오인해 다시 고르면 안 된다."""
    from app.services.embedding_backlog import process_embedding_backlog

    engine, Session = await _session_factory()
    try:
        old = datetime.now(timezone.utc) - timedelta(hours=1)
        _, _, rows = await _seed(Session, ["old-pending"], updated_at=old)
        fake = _BlockingEmbed()
        with patch("app.services.embedding_client.embed_text", side_effect=fake):
            async with Session() as worker_a:
                task_a = asyncio.create_task(process_embedding_backlog(worker_a))
                await fake.wait_started()
                try:
                    claimed = await _get(Session, rows[0].id)
                    async with Session() as worker_b:
                        summary_b = await process_embedding_backlog(worker_b)
                finally:
                    fake.release.set()
                    await task_a
        assert claimed.status == "processing"
        assert claimed.updated_at > old + timedelta(minutes=50)
        assert summary_b["scanned"] == 0
        assert fake.calls == ["old-pending"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_text_changed_during_embed_discards_the_old_vector():
    """embed 도중 enqueue가 글을 바꿈(pending · 새 hash) — 옛 벡터는 쓰지 않는다(superseded). 행은 새 글로 pending 그대로."""
    from app.services.embedding_backlog import process_embedding_backlog
    from app.services.embedding_enqueue import _content_hash, enqueue_embedding

    engine, Session = await _session_factory()
    try:
        org_id, project_id, rows = await _seed(Session, ["before"])
        fake = _BlockingEmbed()
        with patch("app.services.embedding_client.embed_text", side_effect=fake):
            async with Session() as worker:
                task = asyncio.create_task(process_embedding_backlog(worker))
                await fake.wait_started()
                try:
                    async with Session() as editor:
                        await enqueue_embedding(editor, org_id, project_id, "loop", rows[0].entity_id, "after")
                        await editor.commit()
                finally:
                    fake.release.set()
                    summary = await task
        assert summary["superseded"] == [str(rows[0].id)]
        assert summary["embedded"] == []
        row = await _get(Session, rows[0].id)
        assert row.status == "pending"
        assert row.content_hash == _content_hash("after")
        assert row.embedding is None
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_poison_pill_terminates_on_fifth_failure_and_is_not_reselected():
    """retry_count 4인 failed 행이 또 실패(None) → 5 · failed · terminal. 다음 판엔 고르지 않는다(기존 규칙 그대로)."""
    from app.services.embedding_backlog import process_embedding_backlog

    engine, Session = await _session_factory()
    try:
        _, _, rows = await _seed(Session, ["poison"], status="failed", retry_count=4)
        with patch("app.services.embedding_client.embed_text", return_value=None):
            async with Session() as worker:
                first = await process_embedding_backlog(worker)
            async with Session() as worker:
                second = await process_embedding_backlog(worker)
        assert first["terminal"] == [str(rows[0].id)]
        row = await _get(Session, rows[0].id)
        assert (row.status, row.retry_count) == ("failed", 5)
        assert second["scanned"] == 0
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_none_result_keeps_retry_semantics():
    """embed None(원인 구분 불가) → pending · retry_count+1(기존 규칙). processing에 남지 않는다."""
    from app.services.embedding_backlog import process_embedding_backlog

    engine, Session = await _session_factory()
    try:
        _, _, rows = await _seed(Session, ["flaky"])
        with patch("app.services.embedding_client.embed_text", return_value=None):
            async with Session() as worker:
                summary = await process_embedding_backlog(worker)
        assert summary["pending_retry"] == [str(rows[0].id)]
        row = await _get(Session, rows[0].id)
        assert (row.status, row.retry_count) == ("pending", 1)
    finally:
        await engine.dispose()


class _PerTextEmbed:
    """글마다 따로 멈춰 서는 가짜 embed — 워커 둘이 서로 다른 글로 동시에 embed 중인 순간을 만든다."""

    def __init__(self, texts):
        self.calls: list[str] = []
        self.started = {t: threading.Event() for t in texts}
        self.release = {t: threading.Event() for t in texts}

    def __call__(self, text):
        self.calls.append(text)
        self.started[text].set()
        assert self.release[text].wait(20), "테스트가 embed를 풀어 주지 않음"
        return _VECTOR

    async def wait_started(self, text):
        assert await asyncio.to_thread(self.started[text].wait, 20), f"embed({text})가 시작되지 않음"

    def release_all(self):
        for event in self.release.values():
            event.set()


@pytest.mark.anyio
async def test_stale_worker_does_not_overwrite_a_reclaimed_row_with_the_old_vector():
    """A가 옛 글 embed 중 → 글이 바뀜(pending) → B가 새 글로 다시 claim(processing) → A가 먼저 끝남.
    행은 다시 processing이라 status 조건만으론 못 거른다 — content_hash 조건이 A의 옛 벡터를 버린다. B가 새 글로 ready."""
    from app.services.embedding_backlog import process_embedding_backlog
    from app.services.embedding_enqueue import _content_hash, enqueue_embedding

    engine, Session = await _session_factory()
    try:
        org_id, project_id, rows = await _seed(Session, ["before"])
        fake = _PerTextEmbed(["before", "after"])
        with patch("app.services.embedding_client.embed_text", side_effect=fake):
            async with Session() as worker_a, Session() as worker_b:
                task_a = asyncio.create_task(process_embedding_backlog(worker_a))
                try:
                    await fake.wait_started("before")
                    async with Session() as editor:
                        await enqueue_embedding(editor, org_id, project_id, "loop", rows[0].entity_id, "after")
                        await editor.commit()
                    task_b = asyncio.create_task(process_embedding_backlog(worker_b))
                    await fake.wait_started("after")
                    fake.release["before"].set()
                    summary_a = await task_a
                    reclaimed = await _get(Session, rows[0].id)
                finally:
                    fake.release_all()
                summary_b = await task_b
        assert summary_a["superseded"] == [str(rows[0].id)]
        assert (reclaimed.status, reclaimed.embedding) == ("processing", None)  # A가 옛 벡터로 덮지 않음
        assert summary_b["embedded"] == [str(rows[0].id)]
        row = await _get(Session, rows[0].id)
        assert (row.status, row.content_hash) == ("ready", _content_hash("after"))
    finally:
        await engine.dispose()
