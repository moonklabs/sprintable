"""광역 sweep Ⓑ stopgap 회귀 — project_id 를 소비하는 사이트는 임의 .limit(1)(틀린 프로젝트 위험)
대신 deterministic grant-pick(order_by(project_id).limit(1))으로 멀티프로젝트 agent 크래시를 막고
안정적 default project 로 라우팅.

대상(project_id 소비):
  - agent_inbox.receive_inbox_webhook  (Event.project_id 적재)
  - ws_chat.ws_chat_hub                (DM room project 스코프)

true 라우팅(payload-project / 기존-conversation derive)은 follow-up story. 여기선 결정적 stopgap.
"""
from __future__ import annotations

import inspect

import pytest


def _get_func():
    from app.routers import agent_inbox, ws_chat

    return {
        "agent_inbox.receive_inbox_webhook": agent_inbox.receive_inbox_webhook,
        "ws_chat.ws_chat_hub": ws_chat.ws_chat_hub,
    }


# ws_chat_hub 의 agent_member 조회는 default project(room init)용 deterministic grant-pick 유지.
# agent_inbox 는 2c457a06 에서 true-routing(payload project_id 우선·grant 검증·없으면 default)으로
# 졸업 → order_by 는 default 결정성에 유지하되 .limit(1)→.all() 이라 이 가드서 제외(test_s_comm_07 가 커버).
@pytest.mark.parametrize("name", [
    "ws_chat.ws_chat_hub",
])
def test_project_id_site_uses_deterministic_grant_pick(name: str):
    """project_id 소비 사이트는 order_by(project_id)+limit(1)로 결정적(MultipleResultsFound 0·non-random)."""
    fn = _get_func()[name]
    src = inspect.getsource(fn)
    assert "TeamMember" in src, f"{name}: TeamMember 쿼리 사라짐(테스트 갱신 필요)"
    # 결정적 grant-pick: order_by(project_id) + limit(1) 동시 — 임의 행(틀린 프로젝트) 방지
    assert "order_by(TeamMember.project_id)" in src, \
        f"{name}: order_by(project_id) 누락 — 멀티프로젝트 agent 라우팅이 비결정적/크래시"
    assert ".limit(1)" in src, f"{name}: .limit(1) 누락 — MultipleResultsFound 회귀"
    # known-limitation 주석 박제(stopgap 의도·follow-up 추적)
    assert "known-limitation" in src, f"{name}: known-limitation 주석 누락(stopgap 의도 박제 필요)"
