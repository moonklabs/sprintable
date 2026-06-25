"""21496392: story.assignee_changed (+workflow_violation) webhook org-wide fan-out 박멸 가드.

c60dd33c 미러 — fire_webhooks에 recipient_member_ids(관련자) 전달로 무관 에이전트 fan-out 차단.
게이팅 메커니즘 자체는 test_c60dd33c_webhook_payload_gating이 검증(recipient_member_ids 게이팅·
broadcast 보존). 여기선 stories.py 두 호출부가 그 게이팅을 **실제로 배선**했는지 회귀 가드.
publish_event(UI 활동피드·_subscribers)는 org-wide 의도 유지(per-agent 미전파)라 미스코핑.
"""
from __future__ import annotations

import inspect

from app.routers import stories


def test_assignee_changed_fire_webhooks_gated_to_relevant():
    src = inspect.getsource(stories)
    # assignee_changed: recipient_member_ids = 담당자(신/구)+행위자
    assert "recipient_member_ids=_assignee_notify_ids" in src
    assert "story.assignee_id, old_assignee_id, actor_id" in src


def test_workflow_violation_fire_webhooks_gated():
    src = inspect.getsource(stories)
    # workflow_violation도 동일 패턴(행위자+담당자)
    assert "recipient_member_ids=_violation_notify_ids" in src
    assert "actor_id, story.assignee_id" in src


def test_assignee_changed_fire_webhooks_not_bare_orgwide():
    """무게이팅(bare 3-arg) org-wide 호출이 남아있지 않은지 — 회귀 차단."""
    src = inspect.getsource(stories)
    assert 'fire_webhooks(db, org_id, "story.assignee_changed", event_data)' not in src
    assert 'fire_webhooks(db, org_id, "workflow_violation", _v_event)' not in src
