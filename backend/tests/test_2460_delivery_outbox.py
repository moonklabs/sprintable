"""story #2460(§6 봉합②): 웹훅/푸시 배달 트랜잭셔널 아웃박스 테스트.

원 PO 확定 스코프(2026-08-05): story_status_events·conversations send_message 두 콜사이트만
opt-in outbox, 나머지는 기본값 False(즉시 배달). story #2696([클래스 마감], 2026-08-16)에서
이 스코프가 뒤집혔다 — #2687→#2688→#373cfaa1→#2694로 "호출부 트랜잭션 안 동기 webhook POST"
결함이 4번 반복되며 원인이 "기본값이 동기"인 것 자체로 판명, AC1 그라운딩(동기 완료 전제
호출부 0건 확認) 후 dispatch_notification의 via_outbox 기본값을 **True**로 뒤집었다 — 이제
동기가 필요한 자리만 via_outbox=False를 명시한다. fire_webhooks(org_webhook, 이 파일의
별개 축)는 이 스토리 스코프 밖이라 기본값 False 그대로. 이 파일은 그 라우팅 자체와, 워커
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
    # P0(message-loss class fix, 2026-08-08): dispatch_notification()이 이제 본문 전체를
    # begin_nested() SAVEPOINT로 감싸는데(app/services/notification_dispatch.py), 이 fixture는
    # 그걸 async context manager로 안 만들어 bare AsyncMock이 coroutine을 반환 —
    # `async with db.begin_nested():`가 TypeError로 죽어 이 파일의 두 테스트가 dispatch_notification
    # 본문 전체를 건너뛰었다(이전엔 그 예외가 human-branch 내부 try/except에 삼켜져 우연히
    # 안 드러났을 뿐 — RuntimeWarning으로 이미 징후가 있었다). test_notification_dispatch.py의
    # 검증된 패턴 그대로 맞춘다.
    nested_cm = AsyncMock()
    nested_cm.__aenter__ = AsyncMock(return_value=None)
    nested_cm.__aexit__ = AsyncMock(return_value=False)
    session.begin_nested = MagicMock(return_value=nested_cm)
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
         patch("ee.services.expo_push.deliver_expo_push", new=AsyncMock()) as mock_push, \
         patch("ee.services.apns_push.deliver_apns_push", new=AsyncMock()) as mock_apns:
        await dispatch_notification(
            mock_session, org_id=org_id, event_type="conversation.message",
            target_member_ids=[member_id], title="t", via_outbox=True,
        )

    assert mock_wh.call_args.kwargs["via_outbox"] is True
    assert mock_push.call_args.kwargs["via_outbox"] is True
    # story #3064: macOS APNs 채널도 같은 via_outbox 계약을 따른다(세 채널 모두 propagate).
    assert mock_apns.call_args.kwargs["via_outbox"] is True


@pytest.mark.anyio
async def test_dispatch_notification_default_via_outbox_true(mock_session, org_id):
    """story #2696: 이 테스트는 원래 "기본값=False"를 고정하던 자리였다 — 그 목적 자체가
    #2696의 flip으로 뒤집혔으므로 은퇴하지 않고 새 계약(기본값=True)으로 개정한다(이름도
    함께 바꿔 과거 이름이 현재 코드와 모순되는 채로 남지 않게 — Pedro 리뷰 지적,
    2026-08-16). via_outbox 미지정(기본값)이 _deliver_personal_webhooks에 True로
    전파되는지가 지금부터의 계약이다."""
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

    assert mock_wh.call_args.kwargs["via_outbox"] is True


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
    """story #2460 PO 리뷰(F1) 후: _deliver_one이 fetch(세션)→send(세션 없음)로 쪼개졌으므로
    fetch 단계의 session.execute가 빈 targets를 내도록 두고, send가 실제로 호출되는지만
    확인 — 세션·send가 서로 다른 단계에서 불린다는 것 자체가 이 테스트의 핵심 계약."""
    from app.services.delivery_dispatcher import _deliver_one

    job = _job("org_webhook", event="story.status_changed", data={"a": 1}, preserve_broadcast=True)

    fetch_result = MagicMock()
    fetch_result.all.return_value = []  # WebhookConfig 0건 — send는 빈 targets로 호출됨

    session = AsyncMock()
    session.execute = AsyncMock(return_value=fetch_result)
    session.commit = AsyncMock()
    factory_cm = AsyncMock()
    factory_cm.__aenter__ = AsyncMock(return_value=session)
    factory_cm.__aexit__ = AsyncMock(return_value=False)

    with patch("app.core.database.async_session_factory", return_value=factory_cm), \
         patch("app.services.webhook_dispatch._send_webhook_targets", new=AsyncMock()) as mock_send:
        await _deliver_one(job)

    mock_send.assert_awaited_once()
    assert mock_send.call_args[0][0] == []  # fetch가 빈 리스트를 그대로 send에 넘김
    # 마지막 session.execute 호출이 status='delivered' UPDATE여야 한다(fetch의 SELECT는
    # 첫 호출 — 두 호출 다 같은 mock session을 거치므로 call_args는 마지막 호출을 가리킨다).
    values = _update_values(session.execute.call_args[0][0])
    assert values["status"] == "delivered"
    assert values["delivered_at"] is not None


@pytest.mark.anyio
async def test_deliver_one_unknown_kind_raises_and_retries():
    """미지원 kind — 예외로 잡혀 attempts<MAX면 status='pending'로 되돌아간다(다음 tick 재시도).

    story #2460 PO 리뷰(F1) 후: bogus_kind는 org_webhook/personal_webhook/expo_push
    어느 분기에도 안 걸려 fetch용 세션 자체가 안 열린다(kind 판별이 전부 session-open 분기
    「안」이라) — `ValueError`가 세션 밖에서 즉시 발생하므로 `async_session_factory()`는
    except 블록의 상태갱신용 1회만 불린다(구조 변경 전엔 delivery용+상태갱신용 2회)."""
    from app.services.delivery_dispatcher import _deliver_one

    job = _job("bogus_kind")

    status_session = AsyncMock()
    status_session.execute = AsyncMock()
    status_session.commit = AsyncMock()
    factory_cm = AsyncMock()
    factory_cm.__aenter__ = AsyncMock(return_value=status_session)
    factory_cm.__aexit__ = AsyncMock(return_value=False)

    with patch("app.core.database.async_session_factory", return_value=factory_cm):
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
