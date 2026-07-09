"""E-A2A-완성 S-A1(story 2a57dc0f): WORKING 영구정체 방지 — 실 Postgres 검증.

핵심 3축: ⓐ 능동 스위퍼(폴링 무관)가 기한 초과 WORKING task를 FAILED로 승격 + Artifact 첨부
ⓑ 레거시 행(deadline_at NULL)도 created_at 폴백으로 정상 처리 ⓒ webhook delivery 영구실패
확定 시 GetTask 폴링 없이 즉시 FAILED(AC2 훅). story 8236bbc3 컨벤션: create_all 자체 스키마
관리(공유 alembic-migrated DB 오염 방지)."""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

_REAL_DB_URL = os.getenv("PARITY_TEST_DATABASE_URL") or os.getenv("ALEMBIC_DATABASE_URL")

pytestmark = [
    pytest.mark.destructive_schema,
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    """`_update_delivery_status`(AC2 훅 대상)는 `app.core.database`의 **모듈-전역** engine을
    쓴다(자체 세션 팩토리) — anyio 테스트마다 새 이벤트루프가 뜨는데 이 전역 커넥션 풀은 첫
    테스트의 루프에 바인딩된 채 남아 다음 테스트(다른 루프)에서 asyncpg가 cross-loop
    RuntimeError를 낸다. 각 테스트 뒤 풀을 폐기해 다음 테스트가 새 루프에서 새 커넥션을
    맺게 강제 — 실 프로덕션 동작과 무관한 순수 테스트 격리 조치."""
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


async def _session():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from app.core.database import Base
    import app.models  # noqa: F401

    url = _REAL_DB_URL
    for prefix in ("postgresql+psycopg2://", "postgresql+asyncpg://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+asyncpg://" + url[len(prefix):]
            break
    engine = create_async_engine(url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _bypass_fk_for_seed(session) -> None:
    """conversation_webhook_deliveries.message_id는 conversation_messages FK — 이 테스트들은
    delivery-hook 검증이 목적이라 실 Conversation/ConversationMessage 그래프까지는 불필요.
    test_e_recruit_s3_recruit_service_realdb.py와 동일 관례로 세션 스코프 FK 검증을 끈다."""
    from sqlalchemy import text as _text
    await session.execute(_text("SET session_replication_role = replica"))


async def _make_task(session, *, state="TASK_STATE_WORKING", deadline_at=None, created_at=None,
                      root_message_id=None):
    from app.models.a2a_task import A2ATask

    task = A2ATask(
        id=uuid.uuid4(),
        context_id=uuid.uuid4(),
        root_message_id=root_message_id,
        member_id=uuid.uuid4(),
        state=state,
        history=[],
        artifacts=[],
        task_metadata={},
        deadline_at=deadline_at,
    )
    session.add(task)
    await session.flush()
    if created_at is not None:
        # server_default=now() 를 테스트가 원하는 과거값으로 덮어써야 레거시-행 시나리오 재현.
        from sqlalchemy import update
        from app.models.a2a_task import A2ATask as _T
        await session.execute(update(_T).where(_T.id == task.id).values(created_at=created_at))
    await session.commit()
    await session.refresh(task)
    return task


@pytest.mark.anyio
async def test_sweeper_fails_expired_working_task_with_explicit_deadline():
    from app.services.a2a_task_lifecycle import sweep_expired_a2a_tasks
    from app.models.a2a_task import A2ATask
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        async with Session() as s:
            past_deadline = datetime.now(timezone.utc) - timedelta(minutes=1)
            task = await _make_task(s, deadline_at=past_deadline)

            result = await sweep_expired_a2a_tasks(s)
            assert result["swept_count"] == 1
            assert str(task.id) in result["task_ids"]

            reloaded = (await s.execute(select(A2ATask).where(A2ATask.id == task.id))).scalar_one()
            assert reloaded.state == "TASK_STATE_FAILED"
            assert "failure_reason" in reloaded.task_metadata
            assert len(reloaded.artifacts) == 1
            assert reloaded.artifacts[0]["name"] == "failure-reason"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sweeper_leaves_not_yet_expired_task_working():
    from app.services.a2a_task_lifecycle import sweep_expired_a2a_tasks
    from app.models.a2a_task import A2ATask
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        async with Session() as s:
            future_deadline = datetime.now(timezone.utc) + timedelta(minutes=30)
            task = await _make_task(s, deadline_at=future_deadline)

            result = await sweep_expired_a2a_tasks(s)
            assert result["swept_count"] == 0

            reloaded = (await s.execute(select(A2ATask).where(A2ATask.id == task.id))).scalar_one()
            assert reloaded.state == "TASK_STATE_WORKING"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sweeper_falls_back_to_created_at_for_legacy_null_deadline():
    from app.services.a2a_task_lifecycle import sweep_expired_a2a_tasks, A2A_TASK_TIMEOUT_MINUTES
    from app.models.a2a_task import A2ATask
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        async with Session() as s:
            old_created_at = datetime.now(timezone.utc) - timedelta(minutes=A2A_TASK_TIMEOUT_MINUTES + 5)
            task = await _make_task(s, deadline_at=None, created_at=old_created_at)

            result = await sweep_expired_a2a_tasks(s)
            assert result["swept_count"] == 1

            reloaded = (await s.execute(select(A2ATask).where(A2ATask.id == task.id))).scalar_one()
            assert reloaded.state == "TASK_STATE_FAILED"
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_sweeper_ignores_non_working_states():
    from app.services.a2a_task_lifecycle import sweep_expired_a2a_tasks
    from app.models.a2a_task import A2ATask
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        async with Session() as s:
            past_deadline = datetime.now(timezone.utc) - timedelta(minutes=1)
            completed = await _make_task(s, state="TASK_STATE_COMPLETED", deadline_at=past_deadline)
            failed = await _make_task(s, state="TASK_STATE_FAILED", deadline_at=past_deadline)

            result = await sweep_expired_a2a_tasks(s)
            assert result["swept_count"] == 0

            for tid in (completed.id, failed.id):
                reloaded = (await s.execute(select(A2ATask).where(A2ATask.id == tid))).scalar_one()
                assert reloaded.state in ("TASK_STATE_COMPLETED", "TASK_STATE_FAILED")
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_cas_prevents_sweeper_from_clobbering_concurrently_completed_task():
    """까심 QA HIGH C 회귀 방지 — 실 PG 2세션 레이스 재현. 스위퍼가 후보를 SELECT한 *이후*,
    다른 트랜잭션(GetTask 정상완료 경로 시뮬레이션)이 먼저 그 task를 진짜 artifact와 함께
    COMPLETED로 커밋하면, 스위퍼의 CAS UPDATE는 `WHERE state='TASK_STATE_WORKING'`에 걸려
    영향행 0 → skip해야 한다. fix 전엔 스위퍼가 무조건 덮어써 정상 완료된 task가 가짜
    "deadline sweep" FAILED로 오염되고 자가치유되지 않았다(`state=='WORKING'` 게이트에
    막혀 아무 경로도 재교정 안 함)."""
    from app.models.a2a_task import A2ATask
    from app.services.a2a_task_lifecycle import fail_task_if_still_working
    from sqlalchemy import select, update

    engine, Session = await _session()
    try:
        past_deadline = datetime.now(timezone.utc) - timedelta(minutes=1)
        async with Session() as s:
            task = await _make_task(s, deadline_at=past_deadline)
            task_id = task.id

        # TxA(스위퍼 시뮬레이션): 후보 SELECT — 이 시점엔 WORKING(TxB 커밋 전).
        session_a = Session()
        candidates = [
            row[0] for row in (await session_a.execute(
                select(A2ATask.id).where(A2ATask.id == task_id, A2ATask.state == "TASK_STATE_WORKING")
            )).all()
        ]
        assert task_id in candidates

        # TxB(GetTask 정상완료 경로): 독립 세션+독립 커밋 — SELECT~UPDATE 사이 윈도우에서
        # 진짜로 먼저 COMPLETED 커밋(실 레이스 재현, mock 아님).
        async with Session() as session_b:
            await session_b.execute(
                update(A2ATask).where(A2ATask.id == task_id).values(
                    state="TASK_STATE_COMPLETED",
                    artifacts=[{"artifactId": "real-reply", "name": "agent-reply",
                                "parts": [{"text": "정상 완료된 실 작업 결과물"}]}],
                )
            )
            await session_b.commit()

        # TxA: 이제서야 CAS UPDATE 시도 — WHERE state='TASK_STATE_WORKING'에 이미 안 걸림.
        transitioned = await fail_task_if_still_working(
            session_a, task_id, "deadline sweep: no agent response within 30m of task creation",
        )
        await session_a.commit()
        await session_a.close()
        assert transitioned is False, "CAS가 이미 COMPLETED인 task를 덮어씀 — 회귀"

        async with Session() as s:
            final = (await s.execute(select(A2ATask).where(A2ATask.id == task_id))).scalar_one()
            assert final.state == "TASK_STATE_COMPLETED"
            assert final.artifacts[0]["name"] == "agent-reply"  # 진짜 artifact 보존
            assert not any(a.get("name") == "failure-reason" for a in final.artifacts)
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_immediate_fail_hook_on_all_webhook_deliveries_permanently_failed():
    """AC2: `_update_delivery_status(..., "failed")` 도달 즉시(폴링 없이) A2A task FAILED."""
    from app.models.a2a_task import A2ATask
    from app.models.conversation_webhook_delivery import ConversationWebhookDelivery
    from app.services.conversation_webhook import _update_delivery_status
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        message_id = uuid.uuid4()
        async with Session() as s:
            await _bypass_fk_for_seed(s)
            task = await _make_task(
                s, deadline_at=datetime.now(timezone.utc) + timedelta(minutes=30),
                root_message_id=message_id,
            )
            delivery = ConversationWebhookDelivery(
                id=uuid.uuid4(), message_id=message_id, webhook_config_id=uuid.uuid4(),
                status="webhook_posted", attempt_count=0,
            )
            s.add(delivery)
            await s.commit()
            delivery_id = delivery.id

        # 실제 함수는 자체 세션을 여는(async_session_factory) BackgroundTask 진입점 —
        # 실 함수를 그대로 호출해 그 내부 세션 경로까지 실증(mock 아님).
        await _update_delivery_status(delivery_id, "failed", attempt_count=3, last_error="connection refused")

        async with Session() as s:
            reloaded = (await s.execute(select(A2ATask).where(A2ATask.id == task.id))).scalar_one()
            assert reloaded.state == "TASK_STATE_FAILED"
            assert "webhook delivery failed" in reloaded.task_metadata["failure_reason"]
            assert len(reloaded.artifacts) == 1
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_immediate_fail_hook_noop_when_other_channel_still_pending():
    """multi-webhook: 하나만 failed·다른 채널 아직 진행 중이면 즉시-FAILED 훅 no-op(응답 대기 지속)."""
    from app.models.a2a_task import A2ATask
    from app.models.conversation_webhook_delivery import ConversationWebhookDelivery
    from app.services.conversation_webhook import _update_delivery_status
    from sqlalchemy import select

    engine, Session = await _session()
    try:
        message_id = uuid.uuid4()
        async with Session() as s:
            await _bypass_fk_for_seed(s)
            task = await _make_task(
                s, deadline_at=datetime.now(timezone.utc) + timedelta(minutes=30),
                root_message_id=message_id,
            )
            failing = ConversationWebhookDelivery(
                id=uuid.uuid4(), message_id=message_id, webhook_config_id=uuid.uuid4(),
                status="webhook_posted", attempt_count=0,
            )
            still_pending = ConversationWebhookDelivery(
                id=uuid.uuid4(), message_id=message_id, webhook_config_id=uuid.uuid4(),
                status="gateway_accepted", attempt_count=1,
            )
            s.add_all([failing, still_pending])
            await s.commit()
            failing_id = failing.id

        await _update_delivery_status(failing_id, "failed", attempt_count=3, last_error="timeout")

        async with Session() as s:
            reloaded = (await s.execute(select(A2ATask).where(A2ATask.id == task.id))).scalar_one()
            assert reloaded.state == "TASK_STATE_WORKING"  # 다른 채널 진행 중이라 무회귀
    finally:
        await engine.dispose()


@pytest.mark.anyio
async def test_immediate_fail_hook_noop_for_non_a2a_message():
    """A2A task와 무관한 일반 채팅 delivery 실패는 완전 no-op(순수 additive, 회귀 0 증명)."""
    from app.models.conversation_webhook_delivery import ConversationWebhookDelivery
    from app.services.conversation_webhook import _update_delivery_status

    engine, Session = await _session()
    try:
        message_id = uuid.uuid4()  # 어떤 A2ATask.root_message_id도 안 가리킴
        async with Session() as s:
            await _bypass_fk_for_seed(s)
            delivery = ConversationWebhookDelivery(
                id=uuid.uuid4(), message_id=message_id, webhook_config_id=uuid.uuid4(),
                status="webhook_posted", attempt_count=0,
            )
            s.add(delivery)
            await s.commit()
            delivery_id = delivery.id

        # 예외 없이 끝나야(연결된 A2A task가 없어 no-op) — 크래시 0가 이 테스트의 assertion.
        await _update_delivery_status(delivery_id, "failed", attempt_count=3, last_error="dns error")
    finally:
        await engine.dispose()
