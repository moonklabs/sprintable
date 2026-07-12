"""E-GLANCE wedge #2(story 96b19bc3) — app/services/epic_events.py 단위 테스트.

emit_story_status_changed 격리 테스트(test_emit_story_status_changed_isolation.py)와 동형
패턴: publish_event/fire_webhooks/dispatch_notification을 mock해 (1) 각 이벤트타입의
정확한 event_type+payload shape, (2) side-effect 실패가 전파되지 않음(best-effort 격리),
(3) status_changed의 old==new no-op 가드를 검증한다."""
from __future__ import annotations

import uuid
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.epic_events import (
    emit_epic_created,
    emit_epic_reordered,
    emit_epic_removed,
    emit_epic_status_changed,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _epic(status: str = "active", assignee_id: uuid.UUID | None = None):
    return SimpleNamespace(
        id=uuid.uuid4(), title="Epic X", project_id=uuid.uuid4(), status=status,
        assignee_id=assignee_id,
    )


def _base_patches(stack: ExitStack, *, publish=None, webhook=None, notif=None):
    stack.enter_context(patch("app.routers.events.publish_event", publish or MagicMock()))
    stack.enter_context(patch(
        "app.services.webhook_dispatch.fire_webhooks", webhook or AsyncMock(),
    ))
    stack.enter_context(patch(
        "app.services.notification_dispatch.dispatch_notification", notif or AsyncMock(),
    ))


@pytest.mark.anyio
async def test_emit_epic_created_fires_publish_and_webhook_with_correct_shape():
    epic = _epic()
    publish = MagicMock()
    webhook = AsyncMock()
    with ExitStack() as stack:
        _base_patches(stack, publish=publish, webhook=webhook)
        await emit_epic_created(AsyncMock(), uuid.uuid4(), epic, actor_id=uuid.uuid4())

    publish.assert_called_once()
    args = publish.call_args[0]
    assert args[1] == "epic.created"
    assert args[2]["epic_id"] == str(epic.id)
    assert args[2]["epic_title"] == "Epic X"

    webhook.assert_awaited_once()
    wh_args = webhook.call_args[0]
    assert wh_args[2] == "epic.created"
    # 까심 QA(#2076 REQUEST_CHANGES) 회귀가드: assignee 없으면 recipient_member_ids는 반드시
    # None(게이팅 미적용)이어야 한다 — 빈 집합이면 fire_webhooks가 member-bound 웹훅(오르테가
    # 포함)을 전부 drop한다(WebhookConfig.member_id nullable=False, broadcast 개념 없음).
    assert webhook.call_args.kwargs["recipient_member_ids"] is None


@pytest.mark.anyio
async def test_emit_epic_created_with_assignee_gates_to_that_member_not_empty_set():
    """assignee 있으면 그 멤버로 게이팅(의도된 동작) — None도 빈 집합도 아님."""
    assignee_id = uuid.uuid4()
    epic = _epic(assignee_id=assignee_id)
    webhook = AsyncMock()
    with ExitStack() as stack:
        _base_patches(stack, webhook=webhook)
        await emit_epic_created(AsyncMock(), uuid.uuid4(), epic)

    assert webhook.call_args.kwargs["recipient_member_ids"] == {assignee_id}


@pytest.mark.anyio
async def test_emit_epic_status_changed_no_op_when_old_equals_new():
    """old_status == epic.status면 완전 no-op(publish_event조차 호출 안 됨) —
    emit_story_status_changed와 동형 규율."""
    epic = _epic(status="active")
    publish = MagicMock()
    webhook = AsyncMock()
    with ExitStack() as stack:
        _base_patches(stack, publish=publish, webhook=webhook)
        await emit_epic_status_changed(AsyncMock(), uuid.uuid4(), epic, "active")

    publish.assert_not_called()
    webhook.assert_not_awaited()


@pytest.mark.anyio
async def test_emit_epic_status_changed_fires_with_old_and_new_status():
    epic = _epic(status="done")
    publish = MagicMock()
    with ExitStack() as stack:
        _base_patches(stack, publish=publish)
        await emit_epic_status_changed(AsyncMock(), uuid.uuid4(), epic, "active")

    publish.assert_called_once()
    payload = publish.call_args[0][2]
    assert payload["old_status"] == "active"
    assert payload["status"] == "done"


@pytest.mark.anyio
async def test_emit_epic_removed_uses_pre_captured_title_not_epic_object():
    """삭제 後엔 epic 객체 조회 불가 — 호출자가 넘긴 title/project_id로만 payload 구성."""
    publish = MagicMock()
    webhook = AsyncMock()
    epic_id = uuid.uuid4()
    project_id = uuid.uuid4()
    with ExitStack() as stack:
        _base_patches(stack, publish=publish, webhook=webhook)
        await emit_epic_removed(AsyncMock(), uuid.uuid4(), epic_id, "Deleted Epic", project_id)

    payload = publish.call_args[0][2]
    assert payload["epic_id"] == str(epic_id)
    assert payload["epic_title"] == "Deleted Epic"
    assert payload["project_id"] == str(project_id)
    # 까심 QA(#2076) 회귀가드: epic.removed엔 assignee 개념 자체가 없어 notify_member_id는
    # 항상 None — recipient_member_ids도 반드시 None(빈 집합 아님)이어야 오르테가 도달.
    assert webhook.call_args.kwargs["recipient_member_ids"] is None


@pytest.mark.anyio
async def test_emit_epic_reordered_fires_once_for_batch_not_per_item():
    """배치당 1회 발화(N개 재정렬에 N번 웹훅 방지, §2.3) — items 배열 통째로 payload에."""
    items = [
        {"id": uuid.uuid4(), "title": "A", "project_id": uuid.uuid4(), "position": 1, "old_position": None},
        {"id": uuid.uuid4(), "title": "B", "project_id": uuid.uuid4(), "position": 2, "old_position": 5},
    ]
    publish = MagicMock()
    webhook = AsyncMock()
    with ExitStack() as stack:
        _base_patches(stack, publish=publish, webhook=webhook)
        await emit_epic_reordered(AsyncMock(), uuid.uuid4(), items)

    publish.assert_called_once()
    webhook.assert_awaited_once()
    payload = publish.call_args[0][2]
    assert len(payload["items"]) == 2
    assert payload["items"][1]["old_position"] == 5
    # 까심 QA(#2076) 재현 회귀가드: epic.reordered엔 assignee 개념이 없어 notify_member_id는
    # 항상 None — recipient_member_ids도 반드시 None이어야 한다(까심이 실 배달 0건으로 재현한
    # 정확한 버그: 이 값이 빈 집합이면 fire_webhooks가 게이팅을 활성화해 member-bound 웹훅을
    # 전부 drop — WebhookConfig.member_id nullable=False라 broadcast 구제 경로도 없음).
    assert webhook.call_args.kwargs["recipient_member_ids"] is None


@pytest.mark.anyio
async def test_emit_epic_reordered_empty_items_is_noop():
    publish = MagicMock()
    with ExitStack() as stack:
        _base_patches(stack, publish=publish)
        await emit_epic_reordered(AsyncMock(), uuid.uuid4(), [])
    publish.assert_not_called()


@pytest.mark.anyio
async def test_webhook_failure_does_not_propagate():
    """side-effect 실패가 emit 흐름을 깨지 않음(best-effort 격리 — emit_story_status_changed와 동형)."""
    epic = _epic()
    webhook = AsyncMock(side_effect=RuntimeError("webhook down"))
    with ExitStack() as stack:
        _base_patches(stack, webhook=webhook)
        await emit_epic_created(AsyncMock(), uuid.uuid4(), epic)  # 예외 없이 반환.
    webhook.assert_awaited_once()


@pytest.mark.anyio
async def test_dispatch_notification_only_called_when_assignee_present():
    """assignee_id 없으면 dispatch_notification 미호출(§2.2 "선택적")."""
    epic = _epic(assignee_id=None)
    notif = AsyncMock()
    with ExitStack() as stack:
        _base_patches(stack, notif=notif)
        await emit_epic_created(AsyncMock(), uuid.uuid4(), epic)
    notif.assert_not_awaited()

    epic_with_assignee = _epic(assignee_id=uuid.uuid4())
    notif2 = AsyncMock()
    with ExitStack() as stack:
        _base_patches(stack, notif=notif2)
        await emit_epic_created(AsyncMock(), uuid.uuid4(), epic_with_assignee)
    notif2.assert_awaited_once()
