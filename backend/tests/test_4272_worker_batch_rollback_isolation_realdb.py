"""story #4272 — 워커 배치에서 한 건이 처리 중 DB 오류를 내도 배치가 멈추지 않는다.

rollback은 세션의 ORM 객체를 전부 만료시킨다. 그 뒤 `command.id` 같은 속성을 읽으면 비동기 세션에선 지연 적재가
`MissingGreenlet`으로 터져 except 밖으로 새고, 같은 배치에서 이미 `in_progress`로 잡힌 나머지 명령은 영영 처리되지 않는다
(되살리는 장치 없음). 루프가 원시 id만 들고 돌며 건마다 행을 다시 읽으면, 오류 건의 뒤 건도 정상 처리된다.
"""
from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from tests.test_3414_publication_command_core import _session_factory

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="real Postgres 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine

    await _global_engine.dispose()


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    from app.services.channel_credential_crypto import _get_multi_fernet

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    _get_multi_fernet.cache_clear()
    yield
    _get_multi_fernet.cache_clear()


async def _db_error(db) -> None:
    from sqlalchemy import text

    await db.execute(text("SELECT 1/0"))


async def _seed_commands(Session, count: int) -> list[uuid.UUID]:
    from app.models.publication_command import PublicationCommand

    base = datetime.now(UTC) - timedelta(minutes=10)
    ids = [uuid.uuid4() for _ in range(count)]
    async with Session() as s:
        for i, command_id in enumerate(ids):
            s.add(PublicationCommand(
                id=command_id, org_id=uuid.uuid4(), gate_id=uuid.uuid4(), destination=uuid.uuid4(),
                approved_version=uuid.uuid4(), status="pending", requested_by_member_id=uuid.uuid4(),
                created_at=base + timedelta(seconds=i),
            ))
        await s.commit()
    return ids


async def _statuses(Session, ids) -> list[str]:
    from sqlalchemy import select

    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        by_id = dict((await s.execute(
            select(PublicationCommand.id, PublicationCommand.status).where(PublicationCommand.id.in_(ids))
        )).all())
    return [by_id[i] for i in ids]


@pytest.mark.anyio
async def test_a_db_error_in_one_command_does_not_stop_the_rest_of_the_batch(monkeypatch):
    """AC1 — 가운데 건이 DB 오류 → 앞뒤 건은 완료 · 배치는 예외 없이 끝난다.
    뮤테이션: 루프를 미리 읽은 ORM 행 그대로 돌리거나 except 로그를 `command.id`로 되돌리면 RED."""
    import app.services.publication_command as pc

    engine, Session = await _session_factory()
    try:
        ids = await _seed_commands(Session, 3)
        failing = ids[1]

        async def fake_process(db, command, *, now):
            if command.id == failing:
                await _db_error(db)
            command.status = "completed"

        monkeypatch.setattr(pc, "_process_one_command", fake_process)
        async with Session() as s:
            counts = await pc.process_due_publication_commands(s)

        assert (counts["completed"], counts["error"]) == (2, 1), counts
        assert await _statuses(Session, ids) == ["completed", "dead_letter", "completed"]
        async with Session() as s:
            failed = await s.get(pc.PublicationCommand, failing)
            assert (failed.failure_kind, failed.reason_code) == ("needs_check", pc.UNCLASSIFIED_ERROR_CODE)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_failed_command_is_not_left_in_progress_even_when_recording_fails(monkeypatch):
    """오류 건을 dead_letter로 내리는 기록마저 실패해도 뒤 건은 처리된다(기록 실패는 그 건에서 멈춤)."""
    import app.services.publication_command as pc

    engine, Session = await _session_factory()
    try:
        ids = await _seed_commands(Session, 2)

        async def fake_process(db, command, *, now):
            if command.id == ids[0]:
                await _db_error(db)
            command.status = "completed"

        async def failing_record(db, command, **_kwargs):
            await _db_error(db)

        monkeypatch.setattr(pc, "_process_one_command", fake_process)
        monkeypatch.setattr(pc, "apply_command_failure", failing_record)
        async with Session() as s:
            counts = await pc.process_due_publication_commands(s)

        assert counts["completed"] == 1, counts
        assert await _statuses(Session, ids) == ["in_progress", "completed"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_failed_auto_pause_at_the_spend_cap_does_not_break_the_spend_batch(monkeypatch):
    """광고 지출 상한 도달 → 자동 중지 요청이 DB 오류 → `_enforce_spend_cap`이 rollback 뒤 True를 돌려주고 호출부가
    곧바로 run.status를 읽는다. 뮤테이션: rollback 뒤 run 다시 읽기를 빼면 그 읽기가 MissingGreenlet → error로 RED."""
    import app.services.ads_boost_execution as execution
    from app.services.ads_spend_snapshots import process_due_ads_spend_snapshots
    from tests.test_3806_ads_boost_execution import _setup_approved_gate
    from tests.test_3806_ads_boost_spend import _make_spend_snapshots_due, _start_boost
    from tests.test_e4fc29fa_site_post_orchestration import (
        _session_factory as _gate_session_factory,
    )

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(
        await _gate_session_factory(), budget_minor=10_000,
    )
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)
        async with Session() as s:
            await _make_spend_snapshots_due(s, org_id, gate_id)

        async def failing_pause(db, **_kwargs):
            await _db_error(db)

        monkeypatch.setattr(execution, "request_ads_boost_pause", failing_pause)
        async with Session() as s:
            counts = await process_due_ads_spend_snapshots(s)
        assert (counts["captured"], counts["capped"], counts["error"]) == (1, 1, 0), counts
    finally:
        await engine.dispose()


# ── 구조 고정 — 워커 배치 루프는 미리 읽은 ORM 행이 아니라 원시 id를 돈다 ────────────────────────────────────


_BATCH_LOOPS = [
    ("app/services/publication_command.py", "process_due_publication_commands", "command_ids"),
    ("app/services/insight_snapshots.py", "process_due_insight_snapshots", "snapshot_ids"),
    ("app/services/ads_spend_snapshots.py", "process_due_ads_spend_snapshots", "snapshot_ids"),
    ("app/services/channel_post_comments.py", "process_due_comment_collections", "row_ids"),
]


@pytest.mark.parametrize(("path", "function", "ids_name"), _BATCH_LOOPS)
def test_worker_batch_loops_iterate_ids_and_reload_each_row(path, function, ids_name):
    """배치 처리 루프(본문에 rollback이 있는 for)가 `<ids_name>`을 돌고 루프 안에서 db.get으로 다시 읽는지.
    뮤테이션: 루프를 `for row in rows`로 되돌리면 RED(그 뒤 한 건의 rollback이 나머지를 전부 만료시킨다)."""
    import ast
    from pathlib import Path

    tree = ast.parse((Path(__file__).resolve().parents[1] / path).read_text())
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == function)

    def calls(node, attr):
        return [c for c in ast.walk(node) if isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute) and c.func.attr == attr]

    loops = [n for n in ast.walk(fn) if isinstance(n, ast.For) and calls(n, "rollback")]
    assert loops, f"{function}: rollback을 품은 배치 루프를 못 찾음"
    for loop in loops:
        assert isinstance(loop.iter, ast.Name) and loop.iter.id == ids_name, (
            f"{function}:{loop.lineno} — 배치 루프가 `{ids_name}`이 아니라 `{ast.unparse(loop.iter)}`을 돈다"
        )
        assert calls(loop, "get"), f"{function}:{loop.lineno} — 루프 안에서 행을 다시 읽지 않는다"


def test_comment_collection_reloads_the_row_after_rollback():
    """댓글 수집 except는 rollback 뒤 row 속성을 읽는다(실패 표시 · 다음 폴링 예약) — 그 전에 다시 읽어야 한다."""
    import ast
    from pathlib import Path

    tree = ast.parse((Path(__file__).resolve().parents[1] / "app/services/channel_post_comments.py").read_text())
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "process_due_comment_collections")
    handlers = [h for h in ast.walk(fn) if isinstance(h, ast.ExceptHandler) and "rollback" in ast.unparse(h)]
    assert handlers
    for handler in handlers:
        body = [ast.unparse(st) for st in handler.body]
        rollback_at = next(i for i, line in enumerate(body) if "rollback" in line)
        first_read = next(i for i, line in enumerate(body) if "row." in line)
        assert any("db.get(" in line for line in body[rollback_at:first_read]), body
