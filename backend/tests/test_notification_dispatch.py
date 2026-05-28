"""E-EVENTBUS P3 S8: 이벤트→알림 설정 필터 엔진 테스트."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.notification import Notification


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
    session.flush = AsyncMock()
    session.execute = AsyncMock()
    session.refresh = AsyncMock()
    nested_cm = AsyncMock()
    nested_cm.__aenter__ = AsyncMock(return_value=None)
    nested_cm.__aexit__ = AsyncMock(return_value=False)
    session.begin_nested = MagicMock(return_value=nested_cm)
    return session


def _settings_result(rows: list[tuple]) -> MagicMock:
    """[(member_id, enabled), ...] → execute mock result."""
    result = MagicMock()
    rows_mock = []
    for member_id, enabled in rows:
        row = MagicMock()
        row.member_id = member_id
        row.enabled = enabled
        rows_mock.append(row)
    result.all.return_value = rows_mock
    return result


def _members_result(rows: list[tuple]) -> MagicMock:
    """[(id, user_id), ...] → execute mock result."""
    result = MagicMock()
    rows_mock = []
    for mid, uid in rows:
        row = MagicMock()
        row.id = mid
        row.user_id = uid
        row.type = "human"      # human → Notification INSERT
        row.project_id = None   # None → Event INSERT 스킵 (1번 add)
        rows_mock.append(row)
    result.all.return_value = rows_mock
    return result


# ─── enabled=False → Notification 미생성 ─────────────────────────────────────

@pytest.mark.anyio
async def test_disabled_setting_skips_notification(mock_session, org_id):
    """enabled=False인 member → Notification 생성 안 됨."""
    from app.services.notification_dispatch import dispatch_notification

    member_id = uuid.uuid4()
    settings = _settings_result([(member_id, False)])
    mock_session.execute.return_value = settings

    await dispatch_notification(
        mock_session,
        org_id=org_id,
        event_type="memo_received",
        target_member_ids=[member_id],
        title="테스트 메모",
    )

    mock_session.add.assert_not_called()


# ─── 설정 없는 member → 기본 enabled ─────────────────────────────────────────

@pytest.mark.anyio
async def test_no_setting_defaults_to_enabled(mock_session, org_id):
    """notification_settings 없는 member → 기본 enabled → Notification 생성됨."""
    from app.services.notification_dispatch import dispatch_notification

    member_id = uuid.uuid4()
    user_id = uuid.uuid4()

    settings = _settings_result([])  # 설정 없음
    wh_result = MagicMock()
    wh_result.scalars.return_value.all.return_value = []
    members = _members_result([(member_id, user_id)])
    mock_session.execute.side_effect = [settings, wh_result, members]

    await dispatch_notification(
        mock_session,
        org_id=org_id,
        event_type="memo_received",
        target_member_ids=[member_id],
        title="테스트 메모",
    )

    mock_session.add.assert_called_once()
    added = mock_session.add.call_args[0][0]
    assert isinstance(added, Notification)
    assert added.user_id == user_id
    assert added.type == "memo_received"
    assert added.org_id == org_id


# ─── enabled=True → Notification 생성 ────────────────────────────────────────

@pytest.mark.anyio
async def test_enabled_setting_creates_notification(mock_session, org_id):
    """enabled=True 설정 → Notification 생성됨."""
    from app.services.notification_dispatch import dispatch_notification

    member_id = uuid.uuid4()
    user_id = uuid.uuid4()

    settings = _settings_result([(member_id, True)])
    wh_result = MagicMock()
    wh_result.scalars.return_value.all.return_value = []
    members = _members_result([(member_id, user_id)])
    mock_session.execute.side_effect = [settings, wh_result, members]

    await dispatch_notification(
        mock_session,
        org_id=org_id,
        event_type="memo_received",
        target_member_ids=[member_id],
        title="알림 제목",
        body="알림 내용",
        reference_type="memo",
        reference_id=uuid.uuid4(),
    )

    mock_session.add.assert_called_once()
    added = mock_session.add.call_args[0][0]
    assert added.title == "알림 제목"
    assert added.body == "알림 내용"
    assert added.reference_type == "memo"
    assert added.is_read is False


# ─── 빈 target → 즉시 반환 ────────────────────────────────────────────────────

@pytest.mark.anyio
async def test_empty_target_skips_all(mock_session, org_id):
    """target_member_ids=[] → DB 조회 없이 반환."""
    from app.services.notification_dispatch import dispatch_notification

    await dispatch_notification(
        mock_session,
        org_id=org_id,
        event_type="memo_received",
        target_member_ids=[],
        title="빈 대상",
    )

    mock_session.execute.assert_not_called()
    mock_session.add.assert_not_called()


# ─── 복수 member 혼합 (1 enabled, 1 disabled) ────────────────────────────────

@pytest.mark.anyio
async def test_mixed_settings_only_enabled_gets_notification(mock_session, org_id):
    """복수 member: enabled=True만 Notification 생성됨."""
    from app.services.notification_dispatch import dispatch_notification

    member_on = uuid.uuid4()
    member_off = uuid.uuid4()
    user_on = uuid.uuid4()

    settings = _settings_result([(member_on, True), (member_off, False)])
    wh_result = MagicMock()
    wh_result.scalars.return_value.all.return_value = []
    members = _members_result([(member_on, user_on)])
    mock_session.execute.side_effect = [settings, wh_result, members]

    await dispatch_notification(
        mock_session,
        org_id=org_id,
        event_type="memo_received",
        target_member_ids=[member_on, member_off],
        title="복수 대상 테스트",
    )

    assert mock_session.add.call_count == 1
    added = mock_session.add.call_args[0][0]
    assert added.user_id == user_on


