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


@pytest.mark.anyio
@pytest.mark.parametrize("died_with", ["all_ids", "campaign_only"])
async def test_an_ads_boost_start_recovered_after_the_mark_resumes_without_a_second_campaign(monkeypatch, died_with):
    """AC4 — 광고 부스트 시작 명령이 표식 뒤에 죽었다(all_ids: ACTIVE 전환 중 · 4268이 id를 ACTIVE 전에 커밋 / campaign_only: 부분 생성).
    회수 → needs_check(자동 재시도 0) → 사람 재시도 → 4268 이어 만들기: 캠페인 생성 호출은 처음 한 번뿐(중복 PAUSED 0)."""
    from app.models.ads_boost_run import AdsBoostRun
    from app.services.publication_command import WORKER_INTERRUPTED_ERROR_CODE
    from tests.test_3806_ads_boost_execution import _setup_approved_gate
    from tests.test_4268_ads_boost_idempotent_start_realdb import (
        _retry,
        _run,
        _spy_sandbox_create,
        _start_command,
    )
    from tests.test_e4fc29fa_site_post_orchestration import (
        _session_factory as _ads_session_factory,
    )

    calls = _spy_sandbox_create(monkeypatch)
    engine, Session, org_id, _project_id, owner_id, gate_id = await _setup_approved_gate(await _ads_session_factory())
    try:
        command_id = await _start_command(Session, org_id, gate_id, owner_id)
        # 첫 틱은 정상으로 끝까지 만든다(생성 1) — 그 뒤 «ACTIVE 중 죽음»의 흔적을 행에 되돌려 놓는다.
        await _tick(Session, datetime.now(UTC))
        assert len(calls) == 1
        first = await _run(Session, gate_id)
        long_ago = datetime.now(UTC) - timedelta(hours=2)
        await _set(Session, command_id, status="in_progress", claimed_at=long_ago, provider_call_started_at=long_ago)
        async with Session() as s:
            run = await s.get(AdsBoostRun, first.id)
            run.status = "pending"
            if died_with == "campaign_only":
                run.adset_id, run.ad_id = None, None
            await s.commit()

        await _tick(Session, datetime.now(UTC))
        row = await _row(Session, command_id)
        assert (row.status, row.failure_kind, row.reason_code) == ("dead_letter", "needs_check", WORKER_INTERRUPTED_ERROR_CODE)
        assert len(calls) == 1, "회수가 광고를 자동으로 다시 만들었다"

        await _retry(Session, org_id, command_id)
        await _tick(Session, datetime.now(UTC))
        after = await _run(Session, gate_id)
        assert after.campaign_id == first.campaign_id, "이어 만들기가 아니라 새 캠페인이 생겼다"
        if died_with == "all_ids":
            assert len(calls) == 1, f"id가 다 있는데 생성을 다시 불렀다: {calls}"
        else:
            assert calls[1] == {"campaign_id": first.campaign_id, "adset_id": None, "ad_id": None}
    finally:
        await engine.dispose()


# ── story #4336 — 틱 예산 · 호출 도중 죽은 명령의 로컬 발행 확인 · 즉시 발행 대기열 ─────────────────────────────────────


@pytest.mark.anyio
async def test_a_command_longer_than_the_whole_tick_budget_is_marked_not_claimed_and_the_tick_goes_on(monkeypatch):
    """PO 04:52Z — 한 건 최악 > 틱 예산 전체(요청 시한 300 → 예산 240)면 집지 않고 `WORKER_TICK_BUDGET_TOO_SMALL`로 드러낸다(pending
    그대로 · 비종결). 같은 틱의 다른 명령은 계속 집힌다. 예산이 커지면(요청 시한 1800) 다음 틱에 집히며 표시가 지워진다.
    뮤테이션: 예산 밖 갈래를 빼면(늘 집음) 큰 명령이 요청 시한 300에서 어댑터로 가 RED · `continue` 대신 `break`면 작은 명령 0회로 RED."""
    import app.core.config as config_module
    from app.services import publication_command as svc

    engine, Session = await _session_factory()
    try:
        big = await _world(Session)
        small = await _world(Session)
        real_worst = svc.command_worst_case_seconds

        async def _worst(db, command):
            return 900 if command.id == big else await real_worst(db, command)  # 900 = YouTube 업로드 전체 상한

        monkeypatch.setattr(svc, "command_worst_case_seconds", _worst)
        called: list = []

        import app.services.channel_posts as channel_posts_module
        from app.services.channel_posts import ChannelPublishProviderError

        async def _adapter(db, *, org_id, draft_id, **_kwargs):
            called.append(org_id)
            raise ChannelPublishProviderError(provider_code="INSTAGRAM_IMAGE_REQUIRED", provider_message="stub")

        monkeypatch.setattr(channel_posts_module, "publish_channel_post_draft", _adapter)
        monkeypatch.setattr(config_module.settings, "publication_worker_scheduler_deadline_seconds", 1800)
        monkeypatch.setattr(config_module.settings, "backend_request_timeout_seconds", 300)

        now = datetime.now(UTC)
        counts = await _tick(Session, now)
        big_row, small_row = await _row(Session, big), await _row(Session, small)
        assert counts["over_budget"] == 1
        assert (big_row.status, big_row.reason_code) == ("pending", svc.OVER_TICK_BUDGET_CODE)
        assert big_row.org_id not in called and small_row.org_id in called, "예산 밖 표시 뒤에도 같은 틱의 다른 명령은 집힌다"

        await _tick(Session, now)
        assert big_row.org_id not in called and (await _row(Session, big)).reason_code == svc.OVER_TICK_BUDGET_CODE

        monkeypatch.setattr(config_module.settings, "backend_request_timeout_seconds", 1800)
        counts = await _tick(Session, now)
        assert counts["over_budget"] == 0 and called.count(big_row.org_id) == 1
        assert (await _row(Session, big)).reason_code != svc.OVER_TICK_BUDGET_CODE
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_command_that_does_not_fit_the_remaining_budget_waits_for_the_next_tick(monkeypatch):
    """남은 예산 < 이 명령의 최악(예산 전체에는 들어감)이면 집지 않고 다음 틱 — 표시 없이 pending 그대로(`deferred`).
    뮤테이션: 남은 예산 대조를 빼면 어댑터 1회로 RED."""
    from app.services import publication_command as svc

    engine, Session = await _session_factory()
    try:
        cmd_id = await _world(Session)

        async def _worst(_db, _command):
            return 100

        monkeypatch.setattr(svc, "command_worst_case_seconds", _worst)
        clock = iter([0.0] + [60.0] * 50)  # 틱 시작 0초 · 첫 집기 때 이미 60초가 흘렀다
        monkeypatch.setattr(svc, "_monotonic", lambda: next(clock))
        calls: list = []
        _counting_adapter(monkeypatch, Session, calls)
        async with Session() as s:
            counts = await svc.process_due_publication_commands(s, now=datetime.now(UTC), tick_budget_seconds=150)
        row = await _row(Session, cmd_id)
        assert counts["deferred"] == 1 and calls == []
        assert (row.status, row.reason_code, row.claimed_at) == ("pending", None, None)
    finally:
        await engine.dispose()


async def _seed_publication(Session, cmd_id, *, sequence: int, status: str = "published"):
    import uuid as _uuid

    from app.models.channel_publication import ChannelPublication

    row = await _row(Session, cmd_id)
    async with Session() as s:
        s.add(ChannelPublication(
            id=_uuid.uuid4(), org_id=row.org_id, gate_id=row.gate_id, version_id=row.approved_version,
            connection_id=row.destination, channel="instagram", sequence=sequence, status=status,
            external_id=f"ext-{sequence}", published_at=datetime.now(UTC) if status == "published" else None,
        ))
        await s.commit()


async def _set_thread(Session, cmd_id, segments: list[str]):
    from sqlalchemy import update

    from app.models.channel_post_version import ChannelPostVersion

    row = await _row(Session, cmd_id)
    async with Session() as s:
        await s.execute(update(ChannelPostVersion).where(ChannelPostVersion.id == row.approved_version).values(channel_payload={"thread": segments}))
        await s.commit()


@pytest.mark.anyio
@pytest.mark.parametrize("published, thread, expected", [
    ([1], [], "completed"),          # 단일 글 — 행 하나 published = 이미 나감
    ([1, 2], ["b"], "completed"),    # 헤드 + 조각 하나 = 행 둘(`[head, *thread]`) 둘 다 published
    ([1], ["b"], "dead_letter"),     # 스레드 일부만 — 모른다(자동 재호출 0)
    ([], [], "dead_letter"),         # 행 없음 — 모른다
])
async def test_a_command_that_died_mid_call_is_completed_only_when_every_publication_row_is_published(
    monkeypatch, published, thread, expected,
):
    """PO 03:58Z (a) — 호출 도중 죽은 명령(표식 있음)은 다시 올리지 않는다: 우리 발행 행이 기대한 조각 수만큼 전부 published면
    completed, 아니면 needs_check dead_letter. 어느 쪽이든 어댑터 0(중복 영상 · 중복 스레드 0).
    뮤테이션: 조각 수 대조에서 헤드 몫(`1 +`)을 빼면 일부만 나간 스레드 칸이 completed로 RED."""
    engine, Session = await _session_factory()
    try:
        cmd_id = await _world(Session)
        if thread:
            await _set_thread(Session, cmd_id, thread)
        for seq in published:
            await _seed_publication(Session, cmd_id, sequence=seq)
        now = datetime.now(UTC)
        long_ago = now - timedelta(hours=2)
        await _set(Session, cmd_id, status="in_progress", claimed_at=long_ago, provider_call_started_at=long_ago, updated_at=long_ago)
        calls: list = []
        _counting_adapter(monkeypatch, Session, calls)
        counts = await _tick(Session, now)
        await _tick(Session, now + timedelta(hours=3))
        assert counts["recovered"] == 1 and calls == []
        assert (await _row(Session, cmd_id)).status == expected
    finally:
        await engine.dispose()


async def _immediate_world(Session):
    """이미지 있는 IG 초안 · 예약 없이 상신 · 승인(즉시 발행 대상)."""
    import uuid as _uuid

    from tests.test_620beefc_channel_post_image_upload import (
        _approve_gate_directly,
        _create_draft,
        _png_bytes,
        _upload_and_confirm,
    )

    async with Session() as s:
        org_id, project_id = await _seed_org(s)
        await _seed_default_role(s, org_id)
        human_id = await _seed_human(s, org_id, project_id)
        connection_id = await _seed_connection(s, org_id, channel="instagram")
        story_id = await _seed_story(s, org_id, project_id)
    from app.main import app

    _setup_org_scoped_app(app, Session, org_id, user_id=human_id, agent=False)
    async with _client_for(app) as client:
        draft_id = await _create_draft(client, org_id=org_id, connection_id=connection_id, story_id=story_id)
        assert (await _upload_and_confirm(client, org_id, draft_id, _png_bytes(800, 800), content_type="image/png")).status_code == 201
        r_submit = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/submit", json={})
        assert r_submit.status_code == 200, r_submit.text
        async with Session() as s:
            await _approve_gate_directly(s, _uuid.UUID(r_submit.json()["gate_id"]))
    return app, org_id, draft_id


async def _commands(Session, org_id):
    from sqlalchemy import select

    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        return (await s.execute(select(PublicationCommand).where(PublicationCommand.org_id == org_id))).scalars().all()


@pytest.mark.anyio
@pytest.mark.parametrize("shape", ["once", "twice_in_a_row", "twice_at_once"])
async def test_publish_now_only_queues_and_the_worker_publishes_once(monkeypatch, shape):
    """PO 03:58Z (b) — 즉시 발행 요청은 공급자를 부르지 않고 명령을 «지금 due»로 둔 뒤 «발행 중»(processing)으로 바로 답한다. 초안
    상세는 `processing_kind="publishing"`. 다음 워커 틱이 한 번 발행한다 — 같은 초안을 연달아 · 동시에 두 번 눌러도 명령 1 · 호출 1.
    뮤테이션: 라우터가 예전처럼 요청 안에서 `publish_channel_post_draft`를 부르면 틱 전 호출 1로 RED."""
    import asyncio

    import app.services.channel_posts as channel_posts_module
    from app.services.channel_posts import ChannelPublishProviderError

    calls: list = []

    async def _adapter(db, *, org_id, draft_id, **_kwargs):
        calls.append(draft_id)
        raise ChannelPublishProviderError(provider_code="INSTAGRAM_IMAGE_REQUIRED", provider_message="stub")

    monkeypatch.setattr(channel_posts_module, "publish_channel_post_draft", _adapter)
    engine, Session = await _session_factory()
    try:
        app, org_id, draft_id = await _immediate_world(Session)
        try:
            async with _client_for(app) as client:
                url = f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish"
                if shape == "twice_at_once":
                    responses = await asyncio.gather(client.post(url), client.post(url))
                else:
                    responses = [await client.post(url)]
                    if shape == "twice_in_a_row":
                        responses.append(await client.post(url))
                detail = await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")
        finally:
            app.dependency_overrides.clear()
        for r in responses:
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["processing"] is True and body["command_id"] and body["published_at"] is None
        assert calls == [], "요청 안에서 공급자를 불렀다"
        assert detail.json()["processing_kind"] == "publishing"
        commands = await _commands(Session, org_id)
        assert len(commands) == 1 and (commands[0].status, commands[0].next_attempt_at) == ("pending", None)

        await _tick(Session, datetime.now(UTC))
        await _tick(Session, datetime.now(UTC) + timedelta(hours=3))
        assert [str(c) for c in calls] == [str(draft_id)], f"워커 호출 {len(calls)}회"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_now_on_a_voided_command_is_refused_as_before(monkeypatch):
    """승인본이 바뀌어 무효가 된 명령은 되살리지 않는다 — 예전 동기 경로와 같은 409 `SITE_POST_REAPPROVAL_REQUIRED` · 명령 voided 그대로."""
    from sqlalchemy import update

    from app.models.publication_command import PublicationCommand

    engine, Session = await _session_factory()
    try:
        app, org_id, draft_id = await _immediate_world(Session)
        try:
            async with _client_for(app) as client:
                url = f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish"
                assert (await client.post(url)).status_code == 200
                async with Session() as s:
                    await s.execute(update(PublicationCommand).where(PublicationCommand.org_id == org_id).values(status="voided", reason_code="CONTENT_CHANGED"))
                    await s.commit()
                r = await client.post(url)
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "SITE_POST_REAPPROVAL_REQUIRED"
        assert [c.status for c in await _commands(Session, org_id)] == ["voided"]
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_draft_detail_does_not_say_publishing_for_a_command_outside_the_tick_budget(monkeypatch):
    """PO 04:57Z — 예산 밖으로 표시된 명령에 «발행 중»이라 말하면 거짓: processing_kind는 null · command_reason_code가 사유를 싣는다."""
    from sqlalchemy import update

    from app.models.publication_command import PublicationCommand
    from app.services.publication_command import OVER_TICK_BUDGET_CODE

    engine, Session = await _session_factory()
    try:
        app, org_id, draft_id = await _immediate_world(Session)
        try:
            async with _client_for(app) as client:
                assert (await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")).status_code == 200
                async with Session() as s:
                    await s.execute(update(PublicationCommand).where(PublicationCommand.org_id == org_id).values(reason_code=OVER_TICK_BUDGET_CODE))
                    await s.commit()
                detail = (await client.get(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}")).json()
        finally:
            app.dependency_overrides.clear()
        assert detail["processing_kind"] is None
        assert detail["command_reason_code"] == OVER_TICK_BUDGET_CODE
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_publish_now_request_makes_no_network_call(monkeypatch):
    """PO 05:24Z 조건 1 — 즉시 발행 요청 안의 검사(preflight)는 DB 읽기뿐: 실제 네트워크 전송층(`AsyncHTTPTransport` · 동기
    `HTTPTransport`)이 한 번이라도 불리면 RED. 테스트 클라이언트는 ASGI 전송이라 이 덫에 안 걸린다.
    뮤테이션: preflight에 공급자 조회(예: 게시 한도 GET)를 넣으면 전송층 호출 1로 RED."""
    import httpx

    calls: list[str] = []

    async def _no_async_network(self, request):
        calls.append(str(request.url))
        raise AssertionError(f"network call during publish-now request: {request.url}")

    def _no_sync_network(self, request):
        calls.append(str(request.url))
        raise AssertionError(f"network call during publish-now request: {request.url}")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _no_async_network)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", _no_sync_network)
    engine, Session = await _session_factory()
    try:
        app, org_id, draft_id = await _immediate_world(Session)
        try:
            async with _client_for(app) as client:
                r = await client.post(f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}/publish")
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 200, r.text
        assert r.json()["processing"] is True
        assert calls == []
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cancel_publish_frees_an_over_budget_command_and_the_draft_can_be_published_again(monkeypatch):
    """PO 05:00Z — 예산 밖으로 멈춘 명령(대기 · 안 집힘 · 호출 표식 없음)은 사용자가 취소할 수 있고(cancelled), 초안은 다시 발행할
    수 있다(같은 명령이 다시 «지금 due»). 뮤테이션: 취소 조건에서 `claimed_at` 확인을 빼도 이 칸은 초록 — 아래 409 테스트가 막는다."""
    from sqlalchemy import update

    from app.models.publication_command import PublicationCommand
    from app.services.publication_command import OVER_TICK_BUDGET_CODE

    engine, Session = await _session_factory()
    try:
        app, org_id, draft_id = await _immediate_world(Session)
        try:
            async with _client_for(app) as client:
                url = f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}"
                assert (await client.post(f"{url}/publish")).status_code == 200
                async with Session() as s:
                    await s.execute(update(PublicationCommand).where(PublicationCommand.org_id == org_id).values(reason_code=OVER_TICK_BUDGET_CODE))
                    await s.commit()
                r_cancel = await client.post(f"{url}/cancel-publish")
                cancelled = [c.status for c in await _commands(Session, org_id)]
                r_again = await client.post(f"{url}/publish")
        finally:
            app.dependency_overrides.clear()
        assert r_cancel.status_code == 200, r_cancel.text
        assert (r_cancel.json()["status"], r_cancel.json()["reason_code"]) == ("cancelled", "CANCELLED_BY_HUMAN")
        assert cancelled == ["cancelled"]
        assert r_again.status_code == 200 and r_again.json()["processing"] is True, r_again.text
        commands = await _commands(Session, org_id)
        assert [(c.status, c.next_attempt_at) for c in commands] == [("pending", None)], "다시 발행하면 같은 명령이 지금 due"
    finally:
        await engine.dispose()


@pytest.mark.anyio
@pytest.mark.parametrize("started", ["claimed", "call_stamped", "in_progress"])
async def test_cancel_publish_refuses_a_command_that_already_started(monkeypatch, started):
    """집혔거나(claimed_at) 공급자 호출 표식이 있거나 진행 중인 명령은 취소하지 않는다 — 409 `PUBLICATION_ALREADY_STARTED` · 명령 그대로
    (결과 확인이 먼저 · 중복 발행 0). 뮤테이션: 취소 조건에서 셋 중 하나를 빼면 그 칸이 RED."""
    from datetime import UTC, datetime

    from sqlalchemy import update

    from app.models.publication_command import PublicationCommand

    values = {
        "claimed": {"claimed_at": datetime.now(UTC)},
        "call_stamped": {"provider_call_started_at": datetime.now(UTC)},
        "in_progress": {"status": "in_progress"},
    }[started]
    engine, Session = await _session_factory()
    try:
        app, org_id, draft_id = await _immediate_world(Session)
        try:
            async with _client_for(app) as client:
                url = f"/api/v2/organizations/{org_id}/channel-posts/drafts/{draft_id}"
                assert (await client.post(f"{url}/publish")).status_code == 200
                async with Session() as s:
                    await s.execute(update(PublicationCommand).where(PublicationCommand.org_id == org_id).values(**values))
                    await s.commit()
                r = await client.post(f"{url}/cancel-publish")
        finally:
            app.dependency_overrides.clear()
        assert r.status_code == 409, r.text
        assert r.json()["error"]["code"] == "PUBLICATION_ALREADY_STARTED"
        assert [c.status for c in await _commands(Session, org_id)] != ["cancelled"]
    finally:
        await engine.dispose()
