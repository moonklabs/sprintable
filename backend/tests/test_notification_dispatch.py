"""E-EVENTBUS P3 S8: 이벤트→알림 설정 필터 엔진 테스트."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

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


def _members_result(rows: list[tuple], project_id=None) -> MagicMock:
    """[(id, user_id), ...] → execute mock result.

    project_id: story #1953 — 단일 project_id를 전 행에 부여(단일-프로젝트 unambiguous 폴백
    추론 테스트용). 기본 None(기존 거동 무회귀 — Event INSERT 스킵)."""
    result = MagicMock()
    rows_mock = []
    for mid, uid in rows:
        row = MagicMock()
        row.id = mid
        row.user_id = uid
        row.type = "human"      # human → Notification INSERT
        row.project_id = project_id
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


# ─── AC2-2: grant-only 휴먼(org_member)도 Notification 수신 (silent drop 방지) ──

@pytest.mark.anyio
async def test_grant_only_human_gets_notification(mock_session, org_id):
    """team_member 없는 grant-only 휴먼(org_member만)도 in-app Notification 생성."""
    from app.services.notification_dispatch import dispatch_notification

    om_id = uuid.uuid4()
    user_id = uuid.uuid4()

    settings = _settings_result([])            # 설정 없음 → 기본 enabled
    wh_result = MagicMock()
    wh_result.scalars.return_value.all.return_value = []
    tm_result = _members_result([])            # team_member 없음
    om_row = MagicMock()
    om_row.id = om_id
    om_row.user_id = user_id
    om_result = MagicMock()
    om_result.all.return_value = [om_row]      # org_member fallback
    mock_session.execute.side_effect = [settings, wh_result, tm_result, om_result]

    await dispatch_notification(
        mock_session,
        org_id=org_id,
        event_type="dispatched",
        target_member_ids=[om_id],
        title="그랜트 알림",
        body="내용",
        reference_type="epic",
        reference_id=uuid.uuid4(),
    )

    # org_member.user_id 기반 Notification 생성 (silent drop 아님)
    mock_session.add.assert_called_once()
    added = mock_session.add.call_args[0][0]
    assert added.user_id == user_id
    assert added.title == "그랜트 알림"


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


@pytest.mark.anyio
async def test_dispatch_dedups_multiproject_view_rows(mock_session, org_id):
    """회귀 버그: team_members 뷰(0088 projection)는 멀티프로젝트 멤버를 N행(동일 id)으로 반환 →
    dedup 없으면 알림이 프로젝트 수만큼 중복 생성됨(Story Assign 시 Inbox 3개 증상).
    member id dedup으로 멤버당 1 알림만 생성되어야 한다."""
    from app.services.notification_dispatch import dispatch_notification

    member_id = uuid.uuid4()
    user_id = uuid.uuid4()
    settings = _settings_result([])
    wh_result = MagicMock()
    wh_result.scalars.return_value.all.return_value = []
    # 멀티프로젝트 멤버 = 같은 (id, user_id) 3행 (3개 프로젝트 소속 재현)
    members = _members_result([(member_id, user_id), (member_id, user_id), (member_id, user_id)])
    mock_session.execute.side_effect = [settings, wh_result, members]

    await dispatch_notification(
        mock_session,
        org_id=org_id,
        event_type="story_assigned",
        target_member_ids=[member_id],
        title="스토리 담당자로 지정됨",
    )

    notifs = [c.args[0] for c in mock_session.add.call_args_list if isinstance(c.args[0], Notification)]
    assert len(notifs) == 1, f"멀티프로젝트 멤버에게 알림 {len(notifs)}개 생성됨 (dedup으로 1개여야)"
    assert notifs[0].user_id == user_id


def _agent_members_result(member_id, project_ids: list) -> MagicMock:
    """멀티프로젝트 에이전트 = 같은 id, 프로젝트별 1행(뷰 N행)."""
    result = MagicMock()
    rows = []
    for pid in project_ids:
        row = MagicMock()
        row.id = member_id
        row.user_id = None
        row.type = "agent"
        row.project_id = pid
        rows.append(row)
    result.all.return_value = rows
    return result


@pytest.mark.anyio
async def test_dispatch_agent_routed_to_source_project(mock_session, org_id, monkeypatch):
    """S2: 멀티프로젝트 에이전트(뷰 N행)는 source_project_id 행으로 라우팅 — 임의 first-project가
    아니라 트리거 프로젝트로 Event 1건 생성."""
    from app.models.event import Event
    from app.services import notification_dispatch as nd

    # extract_activities_best_effort 는 별도 db 작업 → 격리(patch)
    monkeypatch.setattr(
        "app.services.activity_stream.extract_activities_best_effort",
        AsyncMock(return_value=None),
    )

    member_id = uuid.uuid4()
    p1, p2, p3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    settings = _settings_result([])
    wh_result = MagicMock()
    wh_result.scalars.return_value.all.return_value = []
    members = _agent_members_result(member_id, [p1, p2, p3])
    mock_session.execute.side_effect = [settings, wh_result, members]

    await nd.dispatch_notification(
        mock_session,
        org_id=org_id,
        event_type="dispatched",
        target_member_ids=[member_id],
        title="작업 전달",
        reference_type="story",
        reference_id=uuid.uuid4(),
        source_project_id=p2,  # 트리거 프로젝트
    )

    events = [c.args[0] for c in mock_session.add.call_args_list if isinstance(c.args[0], Event)]
    assert len(events) == 1, f"에이전트 Event {len(events)}개 (멤버당 1건이어야)"
    assert events[0].project_id == p2, "Event가 트리거 프로젝트(p2)로 라우팅돼야"
    assert events[0].recipient_id == member_id


@pytest.mark.anyio
async def test_dispatch_agent_no_source_falls_back_first_row(mock_session, org_id, monkeypatch):
    """source_project_id 미지정 시 기존 거동(첫 행) — 하위호환."""
    from app.models.event import Event
    from app.services import notification_dispatch as nd

    monkeypatch.setattr(
        "app.services.activity_stream.extract_activities_best_effort",
        AsyncMock(return_value=None),
    )

    member_id = uuid.uuid4()
    p1, p2 = uuid.uuid4(), uuid.uuid4()
    settings = _settings_result([])
    wh_result = MagicMock()
    wh_result.scalars.return_value.all.return_value = []
    members = _agent_members_result(member_id, [p1, p2])
    mock_session.execute.side_effect = [settings, wh_result, members]

    await nd.dispatch_notification(
        mock_session,
        org_id=org_id,
        event_type="dispatched",
        target_member_ids=[member_id],
        title="작업 전달",
        reference_type="story",
        reference_id=uuid.uuid4(),
    )

    events = [c.args[0] for c in mock_session.add.call_args_list if isinstance(c.args[0], Event)]
    assert len(events) == 1
    assert events[0].project_id == p1  # 첫 행


# ─── story #1953(P1a-S3): org_id/project_id 전 타입 payload enrichment ────────

def _ee_on():
    """dispatch_notification 내부의 `_settings.is_ee_enabled` 를 결정적으로 True 로."""
    from app.core.config import settings
    return patch.object(type(settings), "is_ee_enabled", property(lambda self: True))


def _no_webhook_configs_result() -> MagicMock:
    """_deliver_personal_webhooks 의 WebhookConfig 조회 — 활성 개인 webhook 0건(빈 결과)."""
    result = MagicMock()
    result.scalars.return_value.all.return_value = []
    return result


@pytest.mark.anyio
async def test_dispatch_passes_source_project_id_to_expo_push(mock_session, org_id):
    """source_project_id가 주어지면 그대로 Expo push project_id kwarg로 전달돼야 한다."""
    from app.services.notification_dispatch import dispatch_notification

    member_id, user_id, project_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    settings_r = _settings_result([])
    wh_result = MagicMock()
    wh_result.scalars.return_value.all.return_value = []
    members = _members_result([(member_id, user_id)])
    mock_session.execute.side_effect = [settings_r, wh_result, members, _no_webhook_configs_result()]

    with _ee_on(), patch(
        "ee.services.expo_push.deliver_expo_push", new=AsyncMock()
    ) as mock_push:
        await dispatch_notification(
            mock_session, org_id=org_id, event_type="story_assigned",
            target_member_ids=[member_id], title="담당자 지정",
            reference_type="story", reference_id=uuid.uuid4(),
            source_project_id=project_id,
        )

    assert mock_push.await_args.kwargs["project_id"] == project_id


@pytest.mark.anyio
async def test_dispatch_infers_project_id_when_members_share_single_project(
    mock_session, org_id, monkeypatch,
):
    """source_project_id 미지정 + 대상 member 전원이 동일 project_id → 그 값으로 폴백(신규
    쿼리 없이 기존 members 조회 결과 재사용)."""
    from app.services.notification_dispatch import dispatch_notification

    monkeypatch.setattr(
        "app.services.activity_stream.extract_activities_best_effort",
        AsyncMock(return_value=None),
    )

    member_id, user_id, project_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    settings_r = _settings_result([])
    wh_result = MagicMock()
    wh_result.scalars.return_value.all.return_value = []
    members = _members_result([(member_id, user_id)], project_id=project_id)
    mock_session.execute.side_effect = [settings_r, wh_result, members, _no_webhook_configs_result()]

    with _ee_on(), patch(
        "ee.services.expo_push.deliver_expo_push", new=AsyncMock()
    ) as mock_push:
        await dispatch_notification(
            mock_session, org_id=org_id, event_type="agent_joined",
            target_member_ids=[member_id], title="새 에이전트",
            reference_type="team_member", reference_id=uuid.uuid4(),
        )

    assert mock_push.await_args.kwargs["project_id"] == project_id


@pytest.mark.anyio
async def test_dispatch_project_id_none_when_members_span_multiple_projects(
    mock_session, org_id, monkeypatch,
):
    """source_project_id 미지정 + 대상 member들이 서로 다른 project_id(org-wide 브로드캐스트) →
    모호성이 있으므로 project_id=None(오라우팅 방지, 억지 폴백 금지)."""
    from app.services.notification_dispatch import dispatch_notification

    monkeypatch.setattr(
        "app.services.activity_stream.extract_activities_best_effort",
        AsyncMock(return_value=None),
    )

    m1, m2 = uuid.uuid4(), uuid.uuid4()
    u1, u2 = uuid.uuid4(), uuid.uuid4()
    p1, p2 = uuid.uuid4(), uuid.uuid4()
    settings_r = _settings_result([])
    wh_result = MagicMock()
    wh_result.scalars.return_value.all.return_value = []
    result = MagicMock()
    row1, row2 = MagicMock(), MagicMock()
    row1.id, row1.user_id, row1.type, row1.project_id = m1, u1, "human", p1
    row2.id, row2.user_id, row2.type, row2.project_id = m2, u2, "human", p2
    result.all.return_value = [row1, row2]
    mock_session.execute.side_effect = [settings_r, wh_result, result, _no_webhook_configs_result()]

    with _ee_on(), patch(
        "ee.services.expo_push.deliver_expo_push", new=AsyncMock()
    ) as mock_push:
        await dispatch_notification(
            mock_session, org_id=org_id, event_type="agent_joined",
            target_member_ids=[m1, m2], title="새 에이전트",
            reference_type="team_member", reference_id=uuid.uuid4(),
        )

    assert mock_push.await_args.kwargs["project_id"] is None


@pytest.mark.anyio
async def test_dispatch_passes_story_id_and_sprint_id_through_to_expo_push(mock_session, org_id):
    """task_completed의 story_id·가설 관련 dispatched의 sprint_id — 호출부가 넘긴 값이
    그대로 deliver_expo_push에 전달돼야 한다(신규 조회 0·pass-through)."""
    from app.services.notification_dispatch import dispatch_notification

    member_id, user_id = uuid.uuid4(), uuid.uuid4()
    story_id, sprint_id = uuid.uuid4(), uuid.uuid4()
    settings_r = _settings_result([])
    wh_result = MagicMock()
    wh_result.scalars.return_value.all.return_value = []
    members = _members_result([(member_id, user_id)])
    mock_session.execute.side_effect = [settings_r, wh_result, members, _no_webhook_configs_result()]

    with _ee_on(), patch(
        "ee.services.expo_push.deliver_expo_push", new=AsyncMock()
    ) as mock_push:
        await dispatch_notification(
            mock_session, org_id=org_id, event_type="task_completed",
            target_member_ids=[member_id], title="작업 완료",
            reference_type="task", reference_id=uuid.uuid4(),
            story_id=story_id, sprint_id=sprint_id,
        )

    assert mock_push.await_args.kwargs["story_id"] == story_id
    assert mock_push.await_args.kwargs["sprint_id"] == sprint_id


