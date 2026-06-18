"""광역 sweep 2차 — 라우터 외(services/repositories/dependencies)의 TeamMember.id scalar 잔여 site.

1차 sweep(#1581/#1583/#1585)이 라우터만 드릴다운해 놓친 site. multi-project SENDER(선생님=owner·N
projection 행)가 deliver_conversation_message_webhook 의 sender_name 조회(.limit 없음)서 MultipleResultsFound
→ 전 수신자 미수신(인앱 메시지 P0). exhaustive grep 으로 잔여 전수 봉쇄.

CRASH → .limit(1)(전 행 동형 컬럼 소비):
  - conversation_webhook.deliver_conversation_message_webhook  (sender name·P0)
  - workflow_executions.get_execution                          (agent name)
  - notifications._resolve_notification_user_id                (id/user_id)
  - ownership.assert_agent_owner                               (created_by ownership guard)

SAFE(project_id == 필터로 1행 확정·무변경):
  - current_project.set_current_project / reward.create_reward
"""
from __future__ import annotations

import inspect

import pytest


def _fns():
    from app.dependencies import ownership
    from app.routers import notifications, workflow_executions
    from app.services import conversation_webhook

    return {
        "conversation_webhook.deliver_conversation_message_webhook":
            conversation_webhook.deliver_conversation_message_webhook,
        "workflow_executions.get_execution": workflow_executions.get_execution,
        "notifications._resolve_notification_user_id": notifications._resolve_notification_user_id,
        "ownership.assert_agent_owner": ownership.assert_agent_owner,
    }


@pytest.mark.parametrize("name", [
    "conversation_webhook.deliver_conversation_message_webhook",
    "workflow_executions.get_execution",
    "notifications._resolve_notification_user_id",
    "ownership.assert_agent_owner",
])
def test_teammember_scalar_site_has_limit(name: str):
    """각 잔여 site 가 TeamMember.id scalar 조회에 .limit(1) — multi-project MultipleResultsFound 회귀 방지."""
    src = inspect.getsource(_fns()[name])
    assert "TeamMember" in src, f"{name}: TeamMember 쿼리 사라짐(테스트 갱신 필요)"
    assert ".limit(1)" in src, f"{name}: .limit(1) 누락 — multi-project 행에서 MultipleResultsFound 크래시"


@pytest.mark.parametrize("module,fn,expr", [
    ("app.routers.current_project", "set_current_project", "TeamMember.project_id == body.project_id"),
    ("app.repositories.reward", None, "TeamMember.project_id == project_id"),
])
def test_safe_sites_disambiguated_by_project_filter(module: str, fn: str, expr: str):
    """SAFE 분류 site 는 project_id == 필터로 1행 확정(disambig) — .limit 없이도 안전함을 박제."""
    import importlib

    mod = importlib.import_module(module)
    src = inspect.getsource(mod)
    assert expr in src, f"{module}: '{expr}' disambig 필터 사라짐 — 재분류 필요(이제 crash-prone)"
