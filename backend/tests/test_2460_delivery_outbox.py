"""story #2460(§6 봉합②): 웹훅/푸시 배달 트랜잭셔널 아웃박스 테스트.

PO 확定 스코프(2026-08-05): ①story_status_events ②conversations send_message 두 콜사이트만
outbox 경유(via_outbox=True) — 나머지 12+ dispatch_notification/fire_webhooks 콜사이트는
기본값 False로 즉시 배달(behavior 무변경). 이 파일은 그 opt-in 라우팅 자체와, 워커
(delivery_dispatcher.py)의 claim/배달/재시도 FSM을 correctness 축(중복·유실·순서·재시도)으로
검증한다. ⛔공유 dev 백엔드에 대한 부하테스트는 이 파일 스코프 밖(PO 명시 금지) — 전부
mock 세션 또는 로컬 PG로만 검증한다.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def org_id():
    return uuid.uuid4()


@pytest.fixture
def mock_session():
    session = AsyncMock()
    session.add = MagicMock()
    session.execute = AsyncMock()
    session.commit = AsyncMock()
    return session


# ─── fire_webhooks: via_outbox opt-in 라우팅 ─────────────────────────────────

@pytest.mark.anyio
async def test_fire_webhooks_default_delivers_immediately_no_enqueue(mock_session, org_id):
    """via_outbox 미지정(기본 False) — DeliveryJob enqueue 없이 즉시 WebhookConfig 조회 경로를
    탄다(behavior 무변경 — 12+ 기존 콜사이트가 전제하는 계약)."""
    from app.services.webhook_dispatch import fire_webhooks

    empty_result = MagicMock()
    empty_result.all.return_value = []  # WebhookConfig 0건 → 즉시 return(httpx 불요)
    mock_session.execute.return_value = empty_result

    await fire_webhooks(mock_session, org_id, "story.status_changed", {"x": 1})

    mock_session.execute.assert_called_once()  # WebhookConfig SELECT가 실제로 돔
    mock_session.add.assert_not_called()  # DeliveryJob enqueue 안 함


@pytest.mark.anyio
async def test_fire_webhooks_via_outbox_enqueues_without_immediate_query(mock_session, org_id):
    """via_outbox=True — WebhookConfig 즉시 조회(session.execute) 없이 DeliveryJob만 add."""
    from app.models.delivery_job import DeliveryJob
    from app.services.webhook_dispatch import fire_webhooks

    await fire_webhooks(
        mock_session, org_id, "story.status_changed", {"story_id": "s1"},
        recipient_member_ids={uuid.uuid4()}, via_outbox=True,
    )

    mock_session.execute.assert_not_called()  # 즉시 배달 경로 안 탐(외부 I/O 0)
    mock_session.add.assert_called_once()
    job = mock_session.add.call_args[0][0]
    assert isinstance(job, DeliveryJob)
    assert job.kind == "org_webhook"
    assert job.org_id == org_id
    assert job.payload["event"] == "story.status_changed"


# ─── dispatch_notification: via_outbox가 두 배달 채널 모두에 전파 ────────────

@pytest.mark.anyio
async def test_dispatch_notification_via_outbox_propagates_to_both_channels(mock_session, org_id):
    """via_outbox=True로 부르면 _deliver_personal_webhooks·deliver_expo_push 둘 다
    via_outbox=True로 호출돼야 한다(story_status_events/conversations 콜사이트가 기대하는
    계약 — 한쪽만 새면 그 채널만 여전히 요청 트랜잭션 안에서 외부 I/O를 한다)."""
    from app.services.notification_dispatch import dispatch_notification

    member_id = uuid.uuid4()
    settings_result = MagicMock()
    settings_result.all.return_value = []  # 설정 없음 → 기본 enabled
    webhook_member_result = MagicMock()
    webhook_member_result.scalars.return_value.all.return_value = []
    muted_result = MagicMock()
    muted_result.scalars.return_value.all.return_value = []
    members_result = MagicMock()
    member_row = MagicMock(id=member_id, user_id=uuid.uuid4(), type="human", project_id=None)
    members_result.all.return_value = [member_row]

    mock_session.execute.side_effect = [settings_result, webhook_member_result, muted_result, members_result]

    with patch("app.services.notification_dispatch._deliver_personal_webhooks", new=AsyncMock()) as mock_wh, \
         patch("app.core.config.settings.license_consent", "agreed"), \
         patch("ee.services.expo_push.deliver_expo_push", new=AsyncMock()) as mock_push:
        await dispatch_notification(
            mock_session, org_id=org_id, event_type="conversation.message",
            target_member_ids=[member_id], title="t", via_outbox=True,
        )

    assert mock_wh.call_args.kwargs["via_outbox"] is True
    assert mock_push.call_args.kwargs["via_outbox"] is True


@pytest.mark.anyio
async def test_dispatch_notification_default_via_outbox_false(mock_session, org_id):
    """기본값(via_outbox 미지정)이 기존 12+ 콜사이트 계약대로 False로 전파돼야 한다."""
    from app.services.notification_dispatch import dispatch_notification

    member_id = uuid.uuid4()
    settings_result = MagicMock()
    settings_result.all.return_value = []
    webhook_member_result = MagicMock()
    webhook_member_result.scalars.return_value.all.return_value = []
    muted_result = MagicMock()
    muted_result.scalars.return_value.all.return_value = []
    members_result = MagicMock()
    member_row = MagicMock(id=member_id, user_id=uuid.uuid4(), type="human", project_id=None)
    members_result.all.return_value = [member_row]

    mock_session.execute.side_effect = [settings_result, webhook_member_result, muted_result, members_result]

    with patch("app.services.notification_dispatch._deliver_personal_webhooks", new=AsyncMock()) as mock_wh:
        await dispatch_notification(
            mock_session, org_id=org_id, event_type="conversation.message",
            target_member_ids=[member_id], title="t",
        )

    assert mock_wh.call_args.kwargs["via_outbox"] is False


# ─── delivery_dispatcher: kind별 라우팅 + 성공/실패 FSM ──────────────────────

def _job(kind: str, **payload) -> dict:
    return {
        "id": uuid.uuid4(), "org_id": uuid.uuid4(), "kind": kind,
        "payload": payload, "attempts": 0,
    }


def _update_values(update_stmt) -> dict:
    """update(...).values(...) 호출에서 컬럼명→바인딩값 dict 추출(테스트 검증용)."""
    return {col.name: bind.value for col, bind in update_stmt._values.items()}


@pytest.mark.anyio
async def test_deliver_one_org_webhook_routes_to_now_and_marks_delivered():
    from app.services.delivery_dispatcher import _deliver_one

    job = _job("org_webhook", event="story.status_changed", data={"a": 1}, preserve_broadcast=True)

    session = AsyncMock()
    session.execute = AsyncMock()
    session.commit = AsyncMock()
    factory_cm = AsyncMock()
    factory_cm.__aenter__ = AsyncMock(return_value=session)
    factory_cm.__aexit__ = AsyncMock(return_value=False)

    with patch("app.core.database.async_session_factory", return_value=factory_cm), \
         patch("app.services.webhook_dispatch._fire_webhooks_now", new=AsyncMock()) as mock_now:
        await _deliver_one(job)

    mock_now.assert_awaited_once()
    values = _update_values(session.execute.call_args[0][0])
    assert values["status"] == "delivered"
    assert values["delivered_at"] is not None


@pytest.mark.anyio
async def test_deliver_one_unknown_kind_raises_and_retries():
    """미지원 kind — 예외로 잡혀 attempts<MAX면 status='pending'로 되돌아간다(다음 tick 재시도)."""
    from app.services.delivery_dispatcher import _deliver_one

    job = _job("bogus_kind")

    delivery_session = AsyncMock()
    delivery_session.execute = AsyncMock(side_effect=RuntimeError("should not reach update"))

    status_session = AsyncMock()
    status_session.execute = AsyncMock()
    status_session.commit = AsyncMock()

    sessions = [delivery_session, status_session]

    class _FakeFactory:
        def __call__(self):
            return self

        async def __aenter__(self):
            return sessions.pop(0)

        async def __aexit__(self, *a):
            return False

    with patch("app.core.database.async_session_factory", _FakeFactory()):
        await _deliver_one(job)

    # status_session에서 status='pending' + last_error 세팅 UPDATE가 실행됐어야 한다.
    status_session.execute.assert_awaited_once()
    status_session.commit.assert_awaited_once()
    values = _update_values(status_session.execute.call_args[0][0])
    assert values["status"] == "pending"
    assert "bogus_kind" in values["last_error"]


@pytest.mark.anyio
async def test_deliver_one_terminal_after_max_attempts():
    """attempts가 이미 _MAX_ATTEMPTS-1(claim에서 +1되면 MAX)이면 실패 시 status='failed'(terminal)."""
    from app.services.delivery_dispatcher import _MAX_ATTEMPTS, _deliver_one

    job = _job("bogus_kind")
    job["attempts"] = _MAX_ATTEMPTS - 1  # _deliver_one 내부에서 +1 → _MAX_ATTEMPTS 도달

    status_session = AsyncMock()
    status_session.execute = AsyncMock()
    status_session.commit = AsyncMock()

    class _FakeFactory:
        def __call__(self):
            return self

        async def __aenter__(self):
            return status_session

        async def __aexit__(self, *a):
            return False

    with patch("app.core.database.async_session_factory", _FakeFactory()):
        await _deliver_one(job)

    values = _update_values(status_session.execute.call_args[0][0])
    assert values["status"] == "failed"  # terminal — 다음 tick부터 pending SELECT에서 영구 제외
