"""c2dfb823: conversation 웹훅 디스패치 참가자 게이팅 가드.

BUG: 첫 프로젝트-스코프 쿼리가 참가자 필터 없이 member-bound webhook까지 끌어와,
대화 참가자가 아닌 멤버(디디 cee1b445·도선윤 66de982b)의 webhook이 프로젝트 내 모든
대화를 수신(선생님→오르테가 DM이 디디 디스코드 채널로 누설).

_select_project_scope_targets 가 게이팅의 단일 진실원. 순수 함수라 DB 없이 결정적 가드.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

from app.services.conversation_webhook import (
    _EVENT_TYPE,
    _select_project_scope_targets,
)

# 시나리오 멤버(실 누설 케이스 모델링)
DIDI = uuid.uuid4()        # 9cac9d96 — 비참가자, 누설 관측 대상
DOSEONYUN = uuid.uuid4()   # 66de982b 구글챗 — 비참가자, events=[] 모니터링 webhook
ORTEGA = uuid.uuid4()      # DM 참가자
SABU = uuid.uuid4()        # DM 참가자(sender)


def _wh(member_id, events=None, url=None):
    return SimpleNamespace(
        id=uuid.uuid4(),
        url=url or f"https://hook/{uuid.uuid4()}",
        secret=None,
        events=events,
        member_id=member_id,
        is_active=True,
    )


# ── AC1/AC3: 비참가자 member-bound webhook 제외 ───────────────────────────────

def test_nonparticipant_member_webhook_excluded():
    """DM 참가자={오르테가,선생님}. 디디·도선윤 webhook(둘 다 member-bound·비참가자) 제외."""
    didi = _wh(DIDI, events=[_EVENT_TYPE])          # cee1b445
    doseonyun = _wh(DOSEONYUN, events=[])           # 66de982b (events=[]=전체구독)
    authorized = {ORTEGA}  # sender(선생님) 제외 후 참가자
    targets = _select_project_scope_targets([didi, doseonyun], authorized)
    assert targets == []


def test_doseonyun_empty_events_still_gated():
    """events=[]은 '전체 이벤트 구독'이지 '브로드캐스트'가 아니다 — member-bound면 참가자 게이팅 적용(AC2)."""
    doseonyun = _wh(DOSEONYUN, events=[])
    targets = _select_project_scope_targets([doseonyun], {ORTEGA})
    assert targets == []


# ── AC3: 디디가 참가자인 대화엔 디디 webhook 포함 ─────────────────────────────

def test_participant_member_webhook_included():
    """디디가 참가자인 group(예: E-GHAPP Bot-S)에는 디디 webhook 정상 포함."""
    didi = _wh(DIDI, events=[_EVENT_TYPE])
    targets = _select_project_scope_targets([didi], {DIDI, ORTEGA})
    assert targets == [didi]


# ── AC2: member_id=null 진짜 브로드캐스트는 무조건 보존 ───────────────────────

def test_null_member_broadcast_always_included():
    """project-broadcast webhook(member_id=null)은 참가자 무관 항상 포함."""
    broadcast = _wh(None, events=[_EVENT_TYPE])
    # 인가 멤버가 없어도(빈 집합) 브로드캐스트는 살아남는다.
    targets = _select_project_scope_targets([broadcast], set())
    assert targets == [broadcast]


def test_broadcast_kept_while_nonparticipant_member_dropped():
    """혼합: 브로드캐스트는 보존, 비참가자 member-bound는 제외(같은 프로젝트)."""
    broadcast = _wh(None, events=[])
    didi = _wh(DIDI, events=[_EVENT_TYPE])
    targets = _select_project_scope_targets([broadcast, didi], {ORTEGA})
    assert targets == [broadcast]


# ── AC4: mentioned/참가자 멤버 webhook 회귀 없음 ─────────────────────────────

def test_mentioned_member_included():
    """@멘션(또는 참가자)된 멤버 webhook은 그대로 동작 — authorized 집합에 들면 포함."""
    didi = _wh(DIDI, events=[_EVENT_TYPE])
    ortega = _wh(ORTEGA, events=None)  # events=None=전체구독
    targets = _select_project_scope_targets([didi, ortega], {DIDI, ORTEGA})
    assert set(t.member_id for t in targets) == {DIDI, ORTEGA}


# ── 이벤트 구독 필터 회귀 가드 ────────────────────────────────────────────────

def test_unsubscribed_event_excluded_even_if_participant():
    """참가자라도 _EVENT_TYPE 미구독 webhook은 제외(events 필터 보존)."""
    didi = _wh(DIDI, events=["some.other.event"])
    targets = _select_project_scope_targets([didi], {DIDI})
    assert targets == []
