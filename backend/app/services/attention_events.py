"""story #3180(S3 후속) — attention(command-center·«지금» 스트립 attention 7종) 상태 변화를
기존 chat SSE 채널로 알린다. `presence_events.py::emit_presence`와 동형(발명 0) — payload
없는 경량 트리거, FE는 이 신호를 받으면 my-actions를 refetch한다(폴링은 폴백으로 유지,
AC3 — 신호를 못 받는 구버전 클라는 현행 폴링 그대로).

attention 7종(agent_stuck·agent_auth_failure·unanswered_blocker·hypothesis_falsified·
loop_overdue_hypothesis·loop_overdue_goal·loop_outcome_missing_goal)은 command_center.py의
my-actions가 매 호출마다 실시간 파생하는 값이다(전용 상태기계·"resolve" API가 따로 없음) —
서버가 "정확히 이 항목 하나가 해소됐다"를 판별할 근거가 없다. 그 파생에 실제로 입력되는
쓰기 경로들(story status·dependency blocks·hypothesis transition·goal transition/측정계획·
agent auth failure)에서 best-effort로 광의 트리거만 쏜다 — 재조회하면 참값을 보므로 과다
발화는 무해하다(AC1 "payload 최소 — 재조회 트리거면 충분").

best-effort: 발행 실패가 caller(story/dependency/hypothesis/goal 쓰기)를 절대 깨지 않는다.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


async def notify_attention_changed(org_id) -> None:
    """org 전체에 «attention changed» 트리거(payload 없음)를 push — presence와 동일 스코프
    (attention 블록 자체가 org-scope, command_center.py my_actions docstring 참조)."""
    try:
        from app.routers.events import push_to_org_members

        await push_to_org_members(str(org_id), "attention.changed", {})
    except Exception:
        logger.warning("emit attention.changed failed org=%s", org_id, exc_info=True)
