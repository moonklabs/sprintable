"""story #4258 — 까디르 4621 codex 두 결함의 가드.

- P2(PO 12:38Z): 멈춤 통지는 전이와 같은 커밋에 남긴 표식(`publication_commands.stop_notice_state = pending`)을 보고 보낸다. 통지
  발행과 `sent` 전환이 한 트랜잭션이라 사라짐 0 · 같은 멈춤 중복 0. 사람이 재시도한 뒤 다시 멈추면 새 통지.
- P1: 통지 문맥 · 수신자 조회는 전부 명령의 조직으로 묶인다(다른 조직 게이트 · 승인자 · 에이전트로 새지 않는다).

하네스는 채널 게시(예약 발행 워커) 경로 — test_4258 본 파일과 같다.
"""
from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from sqlalchemy import select, update

from tests.test_4258_recipe_publish_stopped_notice_realdb import (
    _channel_world,
    _install_notice_definition,
    _last_attempt,
    _notices,
    _run_channel_worker,
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
def _configure_secrets(monkeypatch):
    from cryptography.fernet import Fernet

    import app.core.config as config_module
    from app.services.channel_credential_crypto import _get_multi_fernet

    monkeypatch.setattr(config_module.settings, "channel_credential_encryption_key", Fernet.generate_key().decode())
    _get_multi_fernet.cache_clear()
    yield
    _get_multi_fernet.cache_clear()


async def _command(Session, w):
    from app.models.publication_command import PublicationCommand

    async with Session() as s:
        return (await s.execute(select(PublicationCommand).where(PublicationCommand.org_id == w["org_id"]))).scalar_one()


async def _stop_without_notice(Session, monkeypatch):
    """전이는 커밋됐는데 통지 전에 프로세스가 죽은 틱 — 틱 끝의 통지 단계를 빼고 워커를 돈다."""
    import app.services.recipe_publish_failure as module

    async def _crashed(db, **_kwargs):
        return 0

    with monkeypatch.context() as m:
        m.setattr(module, "deliver_pending_stop_notices", _crashed)
        return await _run_channel_worker(Session)


async def _world(Session):
    _install_notice_definition()
    w = await _channel_world(Session, text="[sandbox:provider-error] 본문")
    await _last_attempt(Session, w)
    return w


# ── P2: 표식 기반 통지 ────────────────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_a_crash_between_the_stop_commit_and_the_notice_is_picked_up_by_the_next_tick(monkeypatch):
    from tests.test_4093_scheduled_publish_event_realdb import _realdb_session

    engine, Session = await _realdb_session()
    try:
        w = await _world(Session)
        counts = await _stop_without_notice(Session, monkeypatch)
        assert counts["dead_letter"] == 1, counts
        assert (await _command(Session, w)).stop_notice_state == "pending"  # 전이와 같은 커밋에 표식
        assert await _notices(Session, w["org_id"]) == []

        counts = await _run_channel_worker(Session)  # 다음 틱(집을 명령은 없고 통지 단계만)
        assert counts["stop_notices"] == 1
        assert len(await _notices(Session, w["org_id"])) == 1
        assert (await _command(Session, w)).stop_notice_state == "sent"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_a_failed_notice_stays_pending_and_the_next_tick_sends_it(monkeypatch):
    """통지 발행이 실패하면 `sent` 전환도 없다(같은 트랜잭션) — 다음 틱이 다시 보낸다. 뮤테이션: `sent`를 통지 전에 따로
    커밋하면 여기서 통지가 영영 0이라 RED."""
    import app.routers.events as events_module
    from tests.test_4093_scheduled_publish_event_realdb import _realdb_session

    engine, Session = await _realdb_session()
    try:
        w = await _world(Session)
        real = events_module.publish_preset_event

        async def _fails(*_args, **_kwargs):
            raise RuntimeError("통지 발행 실패(주입)")

        with monkeypatch.context() as m:
            m.setattr(events_module, "publish_preset_event", _fails)
            counts = await _run_channel_worker(Session)
        assert counts["dead_letter"] == 1 and counts["stop_notices"] == 0, counts
        assert (await _command(Session, w)).stop_notice_state == "pending"
        assert await _notices(Session, w["org_id"]) == []

        assert events_module.publish_preset_event is real
        counts = await _run_channel_worker(Session)
        assert counts["stop_notices"] == 1
        assert len(await _notices(Session, w["org_id"])) == 1
        assert (await _command(Session, w)).stop_notice_state == "sent"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_same_stop_is_notified_once_across_ticks_and_a_new_stop_after_retry_is_notified_again():
    from app.services.publication_command import MAX_RETRIES, retry_dead_letter_command
    from tests.test_4093_scheduled_publish_event_realdb import _realdb_session

    engine, Session = await _realdb_session()
    try:
        w = await _world(Session)
        await _run_channel_worker(Session)
        await _run_channel_worker(Session)
        assert len(await _notices(Session, w["org_id"])) == 1, "같은 멈춤인데 통지가 두 번"

        command = await _command(Session, w)
        async with Session() as s:
            assert await retry_dead_letter_command(s, org_id=w["org_id"], command_id=command.id) is not None
            await s.commit()
        assert (await _command(Session, w)).stop_notice_state is None  # 사람이 다시 시도 → 표식 비움
        from app.models.publication_command import PublicationCommand

        async with Session() as s:
            await s.execute(
                update(PublicationCommand).where(PublicationCommand.id == command.id).values(attempt_count=MAX_RETRIES - 1)
            )
            await s.commit()
        counts = await _run_channel_worker(Session)
        assert counts["dead_letter"] == 1, counts
        assert len(await _notices(Session, w["org_id"])) == 2, "재시도 뒤 다시 멈췄는데 새 통지가 없다"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_two_overlapping_notice_sweeps_send_one_notice(monkeypatch):
    from app.services.recipe_publish_failure import deliver_pending_stop_notices
    from tests.test_4093_scheduled_publish_event_realdb import _realdb_session

    engine, Session = await _realdb_session()
    try:
        w = await _world(Session)
        await _stop_without_notice(Session, monkeypatch)

        async def sweep():
            async with Session() as s:
                return await deliver_pending_stop_notices(s)

        results = await asyncio.gather(sweep(), sweep())
        assert sorted(results) == [0, 1], results
        assert len(await _notices(Session, w["org_id"])) == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_the_db_rejects_an_unknown_stop_notice_state():
    from sqlalchemy.exc import IntegrityError

    from app.models.publication_command import PublicationCommand
    from tests.test_4093_scheduled_publish_event_realdb import _realdb_session

    engine, Session = await _realdb_session()
    try:
        w = await _world(Session)
        async with Session() as s:
            with pytest.raises(IntegrityError):
                await s.execute(
                    update(PublicationCommand).where(PublicationCommand.org_id == w["org_id"]).values(stop_notice_state="later")
                )
                await s.flush()
    finally:
        await engine.dispose()


# ── P1: 조직 범위 ─────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.anyio
async def test_the_failure_context_and_recipients_stay_inside_the_command_org():
    """다른 조직의 게이트 id가 명령에 실려도 문맥이 서지 않는다 · 게이트 승인자가 이 조직 멤버가 아니면 받지 않는다 · 다른 조직
    에이전트가 이 조직 바인딩에 걸려 있어도 받지 않는다. 뮤테이션: `_org_gate`의 조직 조건을 빼면 첫 단언이 RED."""
    from app.models.gate import Gate
    from app.models.publication_command import PublicationCommand
    from app.models.recipe_role_binding import RecipeRoleBinding
    from app.services.recipe_publish_failure import (
        RecipePublishFailureContext,
        recipe_publish_failure_recipients,
        resolve_recipe_publish_failure_context,
    )
    from tests.conftest import seed_org_with_human_owner
    from tests.test_4093_scheduled_publish_event_realdb import _realdb_session, _seed_agent, _seed_story

    engine, Session = await _realdb_session()
    try:
        _install_notice_definition()
        async with Session() as s:
            org_a, project_a, owner_a = await seed_org_with_human_owner(s, slug=f"a4621-{uuid.uuid4().hex[:6]}", org_name="A")
            org_b, project_b, owner_b = await seed_org_with_human_owner(s, slug=f"b4621-{uuid.uuid4().hex[:6]}", org_name="B")
            story_a = await _seed_story(s, org_a, project_a)
            agent_b = await _seed_agent(s, org_b, project_b, name="B 에이전트")
            gate_b = Gate(
                id=uuid.uuid4(), org_id=org_b, work_item_id=story_a, work_item_type="story", gate_type="newsletter_send",
                status="approved", resolver_id=owner_b,
                neutral_facts={"triggered_by_event": "preset.recipe.publish_failed", "stage": "send_requested"},
            )
            s.add(gate_b)
            s.add(RecipeRoleBinding(
                id=uuid.uuid4(), org_id=org_a, project_id=project_a, event_definition_key="org.t4621.recipe",
                stage="send_requested", agent_member_id=agent_b,
            ))
            await s.commit()

            def command(org_id):
                return PublicationCommand(
                    id=uuid.uuid4(), org_id=org_id, gate_id=gate_b.id, destination=uuid.uuid4(), approved_version=uuid.uuid4(),
                    content_kind="newsletter_send", status="dead_letter", requested_by_member_id=owner_a,
                )

            assert await resolve_recipe_publish_failure_context(s, command(org_a)) is None, "다른 조직 게이트로 문맥이 섰다"
            assert await resolve_recipe_publish_failure_context(s, command(org_b)) is not None  # 대조: 같은 조직이면 선다

            ctx = RecipePublishFailureContext(
                "newsletter_send", "org.t4621.recipe", "send_requested", "story", story_a, approver_id=owner_b,
            )
            assert await recipe_publish_failure_recipients(s, org_id=org_a, ctx=ctx) == set()
            own = RecipePublishFailureContext("newsletter_send", "org.t4621.recipe", "send_requested", "story", story_a, owner_a)
            assert await recipe_publish_failure_recipients(s, org_id=org_a, ctx=own) == {owner_a}
    finally:
        await engine.dispose()
