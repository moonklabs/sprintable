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


@pytest.mark.parametrize(("provider_called", "status", "failure_kind", "reason_attr"), [
    (False, "pending", "transient", "PRE_CALL_ERROR_CODE"),
    (True, "dead_letter", "needs_check", "UNCLASSIFIED_ERROR_CODE"),
])
@pytest.mark.anyio
async def test_a_db_error_in_one_command_does_not_stop_the_rest_of_the_batch(
    monkeypatch, provider_called, status, failure_kind, reason_attr,
):
    """AC1 — 가운데 건이 DB 오류 → 앞뒤 건은 완료 · 배치는 예외 없이 끝난다. 오류 건은 공급자 쓰기 호출 직전 표시로 가른다
    (까디르 codex P1 · 4264 원칙): 호출 전이면 아무것도 안 나갔으니 자동 재시도(transient · 다음 시도 예약), 호출 뒤면 모름
    (needs_check dead_letter). 뮤테이션: 루프를 미리 읽은 ORM 행 그대로 · 로그를 `command.id`로 · 표시를 무시하고 한쪽으로
    몰면 RED."""
    import app.services.publication_command as pc
    from app.services.provider_call_mark import mark_provider_call

    engine, Session = await _session_factory()
    try:
        ids = await _seed_commands(Session, 3)
        failing = ids[1]

        async def fake_process(db, command, *, now):
            if command.id == failing:
                if provider_called:
                    mark_provider_call()
                await _db_error(db)
            command.status = "completed"

        monkeypatch.setattr(pc, "_process_one_command", fake_process)
        async with Session() as s:
            counts = await pc.process_due_publication_commands(s)

        assert (counts["completed"], counts["error"]) == (2, 1), counts
        assert await _statuses(Session, ids) == ["completed", status, "completed"]
        async with Session() as s:
            failed = await s.get(pc.PublicationCommand, failing)
            assert (failed.failure_kind, failed.reason_code) == (failure_kind, getattr(pc, reason_attr))
            assert (failed.next_attempt_at is not None) == (not provider_called), "호출 전이면 다음 시도가 예약된다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_failed_command_is_not_left_in_progress_even_when_recording_fails(monkeypatch):
    """오류 건의 실패 기록마저 실패해도 뒤 건은 처리된다(기록 실패는 그 건에서 멈춤)."""
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


@pytest.mark.anyio
async def test_the_spend_refresh_route_survives_a_failed_auto_pause(monkeypatch):
    """새로고침 라우트 — 상한 도달 + 자동 중지 DB 오류 → rollback 뒤에도 활동 기록 · 응답이 선다(까디르 codex P2: 예전엔 만료된
    `gate.id`를 읽다 MissingGreenlet). 뮤테이션: 활동 기록을 `gate.id`로 되돌리고 gate 다시 읽기를 빼면 RED."""
    import app.services.ads_boost_execution as execution
    from app.services.ads_spend_snapshots import refresh_ads_boost_spend_now
    from tests.test_3806_ads_boost_execution import _setup_approved_gate
    from tests.test_3806_ads_boost_spend import _start_boost
    from tests.test_e4fc29fa_site_post_orchestration import (
        _session_factory as _gate_session_factory,
    )

    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(
        await _gate_session_factory(), budget_minor=10_000,
    )
    try:
        await _start_boost(Session, org_id, gate_id, owner_id)

        async def failing_pause(db, **_kwargs):
            await _db_error(db)

        monkeypatch.setattr(execution, "request_ads_boost_pause", failing_pause)
        async with Session() as s:
            result = await refresh_ads_boost_spend_now(s, org_id=org_id, gate_id=gate_id, requester_member_id=owner_id)
        assert result["cap_reached"] is True and result["run_status"] == "running", result
    finally:
        await engine.dispose()


# ── 실 채널 워커 — 공급자 쓰기 호출 직전 표시 ──────────────────────────────────────────────────────────────


async def _instagram_command(Session):
    from app.main import app
    from tests.test_620beefc_channel_post_image_upload import (
        _client_for,
        _seed_connection,
        _seed_default_role,
        _seed_human,
        _seed_org,
        _seed_story,
        _setup_org_scoped_app,
    )
    from tests.test_3536_channel_image_required import _seed_scheduled_instagram_command

    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        human_id = await _seed_human(s, org_id, project_id)
        connection_id = await _seed_connection(s, org_id, channel="instagram")
        story_id = await _seed_story(s, org_id, project_id)
    _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
    try:
        async with _client_for(app) as client, Session() as s:
            return await _seed_scheduled_instagram_command(
                s, client, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def _channel_media_storage(monkeypatch, tmp_path):
    import app.services.channel_post_images as cpi_module
    from tests.test_620beefc_channel_post_image_upload import _CHANNEL_MEDIA_BUCKET

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage-4272"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")


@pytest.mark.parametrize(("where", "status", "failure_kind", "adapter_called"), [
    ("publishing_limit", "pending", "transient", False),
    ("create_container", "dead_letter", "needs_check", True),
])
@pytest.mark.anyio
async def test_the_channel_worker_splits_an_unclassified_error_on_the_provider_call_mark(
    monkeypatch, _channel_media_storage, where, status, failure_kind, adapter_called,
):
    """코드 없는 예외가 공급자 쓰기 호출 전(게시 한도 읽기)이면 자동 재시도 · 장부 adapter_called=False, 쓰기 호출(컨테이너 생성)
    안이면 needs_check · adapter_called=True(예전: 둘 다 needs_check · 호출 뒤도 False). 뮤테이션: 채널 발행 경로의
    `mark_provider_call()`을 빼면 두 번째 경우가 transient로 RED."""
    from sqlalchemy import select

    import app.services.instagram_publish as instagram_publish_module
    from app.models.publication_attempt import PublicationAttempt
    from app.services.publication_command import (
        PublicationCommand,
        process_due_publication_commands,
    )

    async def boom(*_args, **_kwargs):
        raise RuntimeError("주입된 미분류 예외")

    async def limit_ok(client, *, access_token, threads_user_id):
        return (0, 100, 24 * 60 * 60)

    monkeypatch.setattr(instagram_publish_module, "get_publishing_limit", boom if where == "publishing_limit" else limit_ok)
    if where == "create_container":
        monkeypatch.setattr(instagram_publish_module, "create_container", boom)
    engine, Session = await _session_factory()
    try:
        command_id = await _instagram_command(Session)
        async with Session() as s:
            await process_due_publication_commands(s)
        async with Session() as s:
            row = await s.get(PublicationCommand, command_id)
            attempts = (await s.execute(
                select(PublicationAttempt.adapter_called).where(PublicationAttempt.command_id == command_id)
            )).scalars().all()
        assert (row.status, row.failure_kind) == (status, failure_kind), (row.status, row.failure_kind, row.reason_code)
        assert attempts == [adapter_called]
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


def test_comment_collection_reloads_the_row_inside_the_per_row_try():
    """댓글 수집 — 루프 머리의 재읽기가 행별 try 안(까디르 codex P2 — 재읽기 실패도 그 행만)이고, except는 rollback 뒤 row 속성을
    읽기(실패 표시 · 다음 폴링 예약) 전에 다시 읽는다 — 그 재읽기도 자기 try 안."""
    import ast
    from pathlib import Path

    tree = ast.parse((Path(__file__).resolve().parents[1] / "app/services/channel_post_comments.py").read_text())
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "process_due_comment_collections")
    loop = next(n for n in ast.walk(fn) if isinstance(n, ast.For) and isinstance(n.iter, ast.Name) and n.iter.id == "row_ids")
    assert len(loop.body) == 1 and isinstance(loop.body[0], ast.Try), "루프 본문 전체가 행별 try 하나여야 한다"
    per_row = loop.body[0]
    assert "db.get(" in ast.unparse(per_row.body[0]), "재읽기가 try 첫 문장이어야 한다"
    handler = next(h for h in per_row.handlers if "rollback" in ast.unparse(h))
    rest = handler.body[1:]
    assert "rollback" in ast.unparse(handler.body[0])
    assert len(rest) == 1 and isinstance(rest[0], ast.Try), "rollback 뒤 실패 표시가 자기 try 안이어야 한다"
    text = ast.unparse(rest[0].body)
    assert text.index("db.get(") < text.index("row."), text
