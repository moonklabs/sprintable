"""E-EVENTBUS S4: 메모 → 이벤트버스 연동 + 기존 웹훅 병행 테스트."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.event import Event
from app.models.team import TeamMember


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def org_id():
    return uuid.uuid4()


@pytest.fixture
def project_id():
    return uuid.UUID("00000000-0000-0000-0000-000000000001")


@pytest.fixture
def mock_session():
    session = AsyncMock()
    session.add = MagicMock()
    session.flush = AsyncMock()
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.execute = AsyncMock()
    # begin_nested() returns an async context manager
    nested_ctx = AsyncMock()
    nested_ctx.__aenter__ = AsyncMock(return_value=None)
    nested_ctx.__aexit__ = AsyncMock(return_value=False)
    session.begin_nested = MagicMock(return_value=nested_ctx)
    return session


# ─── AC1: send_memo → memo_created 이벤트 생성 ───────────────────────────────

@pytest.mark.anyio
async def test_dispatch_memo_event_creates_event_when_enabled(mock_session, org_id, project_id):
    """EVENTBUS_ENABLED=true 시 dispatch_memo_event가 Event를 생성함."""
    from app.services.eventbus import dispatch_memo_event

    recipient_id = uuid.uuid4()
    # team_members 조회 결과 mock
    row_mock = MagicMock()
    row_mock.__iter__ = MagicMock(return_value=iter([(recipient_id, "agent")]))
    result_mock = MagicMock()
    result_mock.all.return_value = [(recipient_id, "agent")]
    mock_session.execute.return_value = result_mock

    with patch("app.services.eventbus.settings") as mock_settings:
        mock_settings.eventbus_enabled = True
        await dispatch_memo_event(
            mock_session,
            org_id=org_id,
            project_id=project_id,
            event_type="memo_created",
            source_entity_id=uuid.uuid4(),
            sender_id=uuid.uuid4(),
            recipient_ids=[recipient_id],
            payload={"title": "테스트 메모", "content_preview": "내용"},
        )

    mock_session.add.assert_called_once()
    added = mock_session.add.call_args[0][0]
    assert isinstance(added, Event)
    assert added.event_type == "memo_created"
    assert added.recipient_id == recipient_id
    assert added.recipient_type == "agent"
    assert added.org_id == org_id


@pytest.mark.anyio
async def test_dispatch_memo_event_noop_when_disabled(mock_session, org_id, project_id):
    """EVENTBUS_ENABLED=false(prod) 시 이벤트 생성 안 함."""
    from app.services.eventbus import dispatch_memo_event

    with patch("app.services.eventbus.settings") as mock_settings:
        mock_settings.eventbus_enabled = False
        await dispatch_memo_event(
            mock_session,
            org_id=org_id,
            project_id=project_id,
            event_type="memo_created",
            source_entity_id=uuid.uuid4(),
            sender_id=uuid.uuid4(),
            recipient_ids=[uuid.uuid4()],
            payload={},
        )

    mock_session.add.assert_not_called()
    mock_session.execute.assert_not_called()


# ─── AC2: reply_memo → memo_replied 이벤트 생성 ──────────────────────────────

@pytest.mark.anyio
async def test_dispatch_memo_replied_event(mock_session, org_id, project_id):
    """memo_replied 이벤트 타입으로 발행됨."""
    from app.services.eventbus import dispatch_memo_event

    recipient_id = uuid.uuid4()
    result_mock = MagicMock()
    result_mock.all.return_value = [(recipient_id, "human")]
    mock_session.execute.return_value = result_mock

    with patch("app.services.eventbus.settings") as mock_settings:
        mock_settings.eventbus_enabled = True
        await dispatch_memo_event(
            mock_session,
            org_id=org_id,
            project_id=project_id,
            event_type="memo_replied",
            source_entity_id=uuid.uuid4(),
            sender_id=uuid.uuid4(),
            recipient_ids=[recipient_id],
            payload={"content_preview": "답신 내용", "thread_id": str(uuid.uuid4())},
        )

    added = mock_session.add.call_args[0][0]
    assert added.event_type == "memo_replied"
    assert added.recipient_type == "human"


# ─── AC4: 기존 웹훅 코드 여전히 존재하는지 ────────────────────────────────────

def test_webhook_dispatch_still_exists_in_create_memo():
    """create_memo에 기존 웹훅 디스패치 코드가 제거되지 않았는지."""
    import inspect
    from app.routers import memos as memos_module
    source = inspect.getsource(memos_module.create_memo)
    assert "_fire_webhook" in source, "create_memo의 기존 웹훅 코드가 제거됨"
    assert "dispatch_memo_event" in source, "create_memo에 eventbus 연동 없음"


def test_webhook_dispatch_still_exists_in_add_reply():
    """add_reply에 기존 웹훅 디스패치 코드가 제거되지 않았는지."""
    import inspect
    from app.routers import memos as memos_module
    source = inspect.getsource(memos_module.add_reply)
    assert "_fire_webhook" in source, "add_reply의 기존 웹훅 코드가 제거됨"
    assert "dispatch_memo_event" in source, "add_reply에 eventbus 연동 없음"


# ─── AC6: prod 환경 분기 — EVENTBUS_ENABLED 플래그 확인 ─────────────────────

def test_eventbus_disabled_by_default():
    """기본값 EVENTBUS_ENABLED=false — prod 안전."""
    from app.core.config import Settings
    s = Settings()
    assert s.eventbus_enabled is False


@pytest.mark.anyio
async def test_dispatch_empty_recipients_skips(mock_session, org_id, project_id):
    """recipient_ids가 비어 있으면 DB 조회 없이 즉시 반환."""
    from app.services.eventbus import dispatch_memo_event

    with patch("app.services.eventbus.settings") as mock_settings:
        mock_settings.eventbus_enabled = True
        await dispatch_memo_event(
            mock_session,
            org_id=org_id,
            project_id=project_id,
            event_type="memo_created",
            source_entity_id=uuid.uuid4(),
            sender_id=None,
            recipient_ids=[],
            payload={},
        )

    mock_session.execute.assert_not_called()
    mock_session.add.assert_not_called()


# ─── SSE push 연동 확인 ───────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_dispatch_calls_push_to_agent_for_agent_recipient(mock_session, org_id, project_id):
    """EVENTBUS_ENABLED=true + recipient_type=agent → _push_to_agent 호출됨."""
    from app.services.eventbus import dispatch_memo_event

    recipient_id = uuid.uuid4()
    result_mock = MagicMock()
    result_mock.all.return_value = [(recipient_id, "agent")]
    mock_session.execute.return_value = result_mock

    with patch("app.services.eventbus.settings") as mock_settings, \
         patch("app.services.eventbus._push_to_agent") as mock_push:
        mock_settings.eventbus_enabled = True
        await dispatch_memo_event(
            mock_session,
            org_id=org_id,
            project_id=project_id,
            event_type="memo_created",
            source_entity_id=uuid.uuid4(),
            sender_id=uuid.uuid4(),
            recipient_ids=[recipient_id],
            payload={"title": "테스트"},
        )

    mock_push.assert_called_once()
    call_member_id = mock_push.call_args[0][0]
    assert call_member_id == str(recipient_id)


@pytest.mark.anyio
async def test_dispatch_no_push_for_human_recipient(mock_session, org_id, project_id):
    """recipient_type=human 이면 _push_to_agent 호출 안 됨."""
    from app.services.eventbus import dispatch_memo_event

    recipient_id = uuid.uuid4()
    result_mock = MagicMock()
    result_mock.all.return_value = [(recipient_id, "human")]
    mock_session.execute.return_value = result_mock

    with patch("app.services.eventbus.settings") as mock_settings, \
         patch("app.services.eventbus._push_to_agent") as mock_push:
        mock_settings.eventbus_enabled = True
        await dispatch_memo_event(
            mock_session,
            org_id=org_id,
            project_id=project_id,
            event_type="memo_created",
            source_entity_id=uuid.uuid4(),
            sender_id=uuid.uuid4(),
            recipient_ids=[recipient_id],
            payload={},
        )

    mock_push.assert_not_called()


# ─── RC 이슈: savepoint로 세션 오염 방지 ─────────────────────────────────────

@pytest.mark.anyio
async def test_dispatch_uses_begin_nested_savepoint(mock_session, org_id, project_id):
    """flush 실패 시 begin_nested() savepoint가 사용돼 outer session 보호됨."""
    from app.services.eventbus import dispatch_memo_event

    recipient_id = uuid.uuid4()
    result_mock = MagicMock()
    result_mock.all.return_value = [(recipient_id, "agent")]
    mock_session.execute.return_value = result_mock

    with patch("app.services.eventbus.settings") as mock_settings, \
         patch("app.services.eventbus._push_to_agent"):
        mock_settings.eventbus_enabled = True
        await dispatch_memo_event(
            mock_session,
            org_id=org_id,
            project_id=project_id,
            event_type="memo_created",
            source_entity_id=uuid.uuid4(),
            sender_id=uuid.uuid4(),
            recipient_ids=[recipient_id],
            payload={},
        )

    mock_session.begin_nested.assert_called_once()


@pytest.mark.anyio
async def test_dispatch_flush_failure_does_not_corrupt_session(org_id, project_id):
    """begin_nested 안에서 예외 발생 시 outer session은 정상 — add가 호출 안 됨."""
    from app.services.eventbus import dispatch_memo_event

    broken_session = AsyncMock()
    broken_session.add = MagicMock()

    # execute 성공 (members 조회)
    result_mock = MagicMock()
    result_mock.all.return_value = [(uuid.uuid4(), "agent")]
    broken_session.execute.return_value = result_mock

    # begin_nested context manager가 예외 발생
    nested_ctx = AsyncMock()
    nested_ctx.__aenter__ = AsyncMock(side_effect=Exception("DB savepoint failed"))
    nested_ctx.__aexit__ = AsyncMock(return_value=False)
    broken_session.begin_nested = MagicMock(return_value=nested_ctx)

    with patch("app.services.eventbus.settings") as mock_settings, \
         patch("app.services.eventbus._push_to_agent") as mock_push:
        mock_settings.eventbus_enabled = True
        # 예외가 밖으로 전파되지 않아야 함
        await dispatch_memo_event(
            broken_session,
            org_id=org_id,
            project_id=project_id,
            event_type="memo_created",
            source_entity_id=uuid.uuid4(),
            sender_id=None,
            recipient_ids=[uuid.uuid4()],
            payload={},
        )

    # savepoint 실패 → add 호출 안 됨 + SSE push 안 됨
    broken_session.add.assert_not_called()
    mock_push.assert_not_called()
