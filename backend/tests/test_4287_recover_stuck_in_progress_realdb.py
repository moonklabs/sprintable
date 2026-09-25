"""story #4287(PO 00:16Z 확정 설계) — 워커가 in_progress로 집은 뒤 죽은 발행 명령의 회수.

- 집을 때 `claimed_at`을 채우고 `provider_call_started_at`(영속 표식)을 비운다.
- 어댑터 진입 직전 표식을 쓰고 **커밋**한다 — 어댑터가 불릴 때 다른 세션에서 이미 보인다.
- 상한 시간(90분)을 넘긴 in_progress: 표식 없음 → 호출 전 확실 → transient 재시도(다음 틱 한 번) · 표식 있음 → needs_check
  dead_letter(자동 재시도 0 · 이중 발행 0) · `claimed_at` 없는 옛 행 → needs_check.
"""
from __future__ import annotations

import ast
import os
import pathlib
from datetime import UTC, datetime, timedelta

import pytest

from tests.test_620beefc_channel_post_image_upload import (
    _client_for,
    _seed_connection,
    _seed_default_role,
    _seed_human,
    _seed_org,
    _seed_story,
    _session_factory,
    _setup_org_scoped_app,
)

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
def _local_channel_media_storage(monkeypatch, tmp_path):
    import app.services.channel_post_images as cpi_module
    from tests.test_620beefc_channel_post_image_upload import _CHANNEL_MEDIA_BUCKET

    monkeypatch.setenv("STORAGE_PROVIDER", "local")
    monkeypatch.setenv("STORAGE_LOCAL_ROOT", str(tmp_path / ".storage-4287"))
    monkeypatch.setattr(cpi_module, "CHANNEL_MEDIA_BUCKET", _CHANNEL_MEDIA_BUCKET)
    monkeypatch.setattr(cpi_module, "_PUBLIC_BASE", f"https://storage.googleapis.com/{_CHANNEL_MEDIA_BUCKET}/")
    yield


@pytest.fixture(autouse=True)
def _configure_secrets(monkeypatch):
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    from app.services.channel_credential_crypto import _get_multi_fernet

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    _get_multi_fernet.cache_clear()
    yield
    _get_multi_fernet.cache_clear()


async def _world(Session):
    """승인된 IG 초안 + 도래한 발행 명령 하나(pending)."""
    from tests.test_3536_channel_image_required import _seed_scheduled_instagram_command

    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        human_id = await _seed_human(s, org_id, project_id)
        connection_id = await _seed_connection(s, org_id, channel="instagram")
        story_id = await _seed_story(s, org_id, project_id)
    from app.main import app

    _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
    try:
        async with _client_for(app) as client, Session() as s:
            cmd_id = await _seed_scheduled_instagram_command(
                s, client, org_id=org_id, connection_id=connection_id, story_id=story_id, human_id=human_id,
            )
    finally:
        app.dependency_overrides.clear()
    return cmd_id


def _counting_adapter(monkeypatch, Session, calls: list):
    """어댑터 대역 — 불린 순간 **다른 세션**에서 표식이 보이는지 적고, «확실히 안 나감» 코드로 실패해 명령을 멈춘다(호출 수만 센다)."""
    import app.services.channel_posts as channel_posts_module
    from app.models.publication_command import PublicationCommand
    from app.services.channel_posts import ChannelPublishProviderError

    async def _adapter(db, *, org_id, draft_id, **_kwargs):
        from sqlalchemy import select

        async with Session() as other:
            stamp = (await other.execute(
                select(PublicationCommand.provider_call_started_at).where(PublicationCommand.org_id == org_id)
            )).scalar_one()
        calls.append(stamp)
        raise ChannelPublishProviderError(provider_code="INSTAGRAM_IMAGE_REQUIRED", provider_message="stub")

    monkeypatch.setattr(channel_posts_module, "publish_channel_post_draft", _adapter)


async def _set(Session, cmd_id, **values):
    from sqlalchemy import update

    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        await s.execute(update(PublicationCommand).where(PublicationCommand.id == cmd_id).values(**values))
        await s.commit()


async def _row(Session, cmd_id):
    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        return await s.get(PublicationCommand, cmd_id)


async def _tick(Session, at):
    from app.services.publication_command import process_due_publication_commands

    async with Session() as s:
        return await process_due_publication_commands(s, now=at)


@pytest.mark.anyio
async def test_the_stamp_is_committed_before_the_adapter_is_called(monkeypatch):
    """집을 때 claimed_at · 표식 비움, 어댑터가 불린 순간 다른 세션에서 표식이 이미 보인다(커밋 뒤 호출).
    뮤테이션: `mark_provider_call_started`의 커밋을 빼면 다른 세션이 None을 보고 RED."""
    engine, Session = await _session_factory()
    try:
        cmd_id = await _world(Session)
        await _set(Session, cmd_id, provider_call_started_at=datetime.now(UTC) - timedelta(days=1))  # 앞 시도의 남은 표식
        calls: list = []
        _counting_adapter(monkeypatch, Session, calls)
        now = datetime.now(UTC)
        await _tick(Session, now)
        assert len(calls) == 1
        assert calls[0] is not None and calls[0] > now - timedelta(minutes=1), "어댑터가 커밋된 이번 시도 표식 없이 불렸다"
        row = await _row(Session, cmd_id)
        assert row.claimed_at is not None
    finally:
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("case", ["before_call", "after_call", "legacy_row"])
async def test_a_command_stuck_in_progress_is_recovered_without_double_publishing(monkeypatch, case):
    """AC1 · AC2 · AC3 — 상한 시간을 넘긴 in_progress:
    - before_call(claimed_at 있음 · 표식 없음) → transient(PRE_CALL)로 pending · 다음 틱에 어댑터 **한 번**.
    - after_call(표식 있음) → needs_check dead_letter · 어댑터 0(멈춤 통지는 `apply_command_failure`의 dead_letter 갈래 그대로).
    - legacy_row(claimed_at 없음 · 옛 행) → needs_check(호출 전으로 읽지 않는다).
    뮤테이션: 판정에서 표식을 무시하면(늘 PRE_CALL) after_call이 어댑터 1로 RED."""
    from app.services.publication_command import (
        PRE_CALL_ERROR_CODE,
        WORKER_INTERRUPTED_ERROR_CODE,
    )

    engine, Session = await _session_factory()
    try:
        cmd_id = await _world(Session)
        now = datetime.now(UTC)
        long_ago = now - timedelta(hours=2)
        await _set(
            Session, cmd_id, status="in_progress",
            claimed_at=None if case == "legacy_row" else long_ago,
            provider_call_started_at=long_ago if case == "after_call" else None,
            updated_at=long_ago,
        )
        calls: list = []
        _counting_adapter(monkeypatch, Session, calls)

        counts = await _tick(Session, now)
        assert counts["recovered"] == 1
        row = await _row(Session, cmd_id)
        if case == "before_call":
            assert (row.status, row.failure_kind, row.reason_code) == ("pending", "transient", PRE_CALL_ERROR_CODE)
            assert row.next_attempt_at is not None and calls == []
            # 백오프 뒤 다음 틱 — 한 번 나가고(대역이 «안 나감»으로 멈춘다) 그 뒤로는 더 안 부른다.
            await _tick(Session, row.next_attempt_at + timedelta(seconds=1))
            await _tick(Session, row.next_attempt_at + timedelta(hours=3))
            assert len(calls) == 1, f"회수 뒤 어댑터 호출 {len(calls)}회"
        else:
            assert (row.status, row.failure_kind, row.reason_code) == (
                "dead_letter", "needs_check", WORKER_INTERRUPTED_ERROR_CODE,
            )
            assert row.next_attempt_at is None and row.dead_letter_at is not None
            await _tick(Session, now + timedelta(hours=3))
            assert calls == [], "나갔는지 모르는 명령을 자동으로 다시 보냈다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_command_still_within_the_limit_is_left_alone(monkeypatch):
    """상한(90분) 안의 in_progress는 살아 있는 요청일 수 있다 — 건드리지 않는다(되살리면 두 번 나간다)."""
    engine, Session = await _session_factory()
    try:
        cmd_id = await _world(Session)
        now = datetime.now(UTC)
        await _set(Session, cmd_id, status="in_progress", claimed_at=now - timedelta(minutes=80), provider_call_started_at=None)
        calls: list = []
        _counting_adapter(monkeypatch, Session, calls)
        counts = await _tick(Session, now)
        row = await _row(Session, cmd_id)
        assert counts["recovered"] == 0 and row.status == "in_progress" and calls == []
    finally:
        await engine.dispose()


def test_the_stamp_precedes_every_adapter_branch():
    """구조 가드 — `_process_one_command`에서 표식 호출이 다섯 갈래(사이트 글 · 댓글 답글 · 광고 · 뉴스레터 · 채널 글) 어댑터 진입보다
    앞선다. 표식이 늦으면(쓰기 뒤) 회수가 이중 발행을 낸다. 뮤테이션: 표식을 채널 글 분기 안으로 내리면 앞 갈래들이 RED."""
    src = pathlib.Path(__file__).resolve().parents[1] / "app" / "services" / "publication_command.py"
    tree = ast.parse(src.read_text(encoding="utf-8"))
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == "_process_one_command")

    def _lines(name):
        return [
            n.lineno for n in ast.walk(fn)
            if isinstance(n, ast.Call) and (getattr(n.func, "id", None) or getattr(n.func, "attr", None)) == name
        ]

    stamp = _lines("mark_provider_call_started")
    assert len(stamp) == 1
    for adapter in (
        "_process_one_site_post_command", "_process_one_comment_reply_command", "process_one_ads_boost_command",
        "process_one_newsletter_send_command", "publish_channel_post_draft",
    ):
        assert _lines(adapter), adapter
        assert stamp[0] < min(_lines(adapter)), f"{adapter}가 영속 표식보다 앞에서 불린다"
