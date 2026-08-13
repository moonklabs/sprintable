"""채널 라우터 회귀 — org-agent 멀티프로젝트 sender 가 team_members VIEW 다중 행을 내도
route_message 가 MultipleResultsFound 로 안 깨지고 dispatch 되는지(sender_type 쿼리 .limit(1)).

배경: team_members 는 0088 이후 projection VIEW. org-agent 멀티프로젝트 grant(project_access)면
같은 member.id 가 프로젝트 수만큼 행 → sender_type 의 무필터 scalar_one_or_none 이 MultipleResultsFound
→ route_message 전체가 ChannelRouterError 로 깨져 chat→agent dispatch 정지. .limit(1) 로 봉합.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# story #2608 P1: route_message()은 sender_type=="agent"면 compute_agent_chain_depth를 추가로
# 호출한다(그 함수 자체가 내부적으로 db.execute를 더 쓴다) — 기존 db.execute side_effect
# 리스트를 안 건드리려고 그 함수 자체를 patch해 고정 depth를 준다. depth=1(<=cap)로 두면
# 이 파일의 기존(P1 이전) 시나리오들은 전부 무회귀로 그대로 통과한다.
_NOT_EXPIRED = patch(
    "app.services.channel_router.compute_agent_chain_depth", AsyncMock(return_value=1),
)

# 핫픽스(2026-08-13): agent 그룹챗 mentions 기본계약은 settings.agent_group_default_mentions
# (기본 False)로 게이트됐다 — 그 분기 자체(메커니즘)를 계속 커버하는 테스트는 명시로 켠다.
_MENTIONS_ON = patch(
    "app.services.channel_router.settings.agent_group_default_mentions", True,
)


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _scalar(val):
    r = MagicMock()
    r.scalar_one_or_none.return_value = val
    return r


def _scalars(items):
    r = MagicMock()
    r.scalars.return_value.all.return_value = items
    return r


def _all(rows):
    r = MagicMock()
    r.all.return_value = rows
    return r


def _pref(member_id, *, scope_type="global", scope_id=None, channel="sse", level="mute"):
    p = MagicMock()
    p.member_id = member_id
    p.scope_type = scope_type
    p.scope_id = scope_id
    p.channel = channel
    p.level = level
    return p


def _row(**attrs):
    """story #2603 P0: conv_row 조회가 scalar 하나가 아니라 (project_id, type, free_response)
    Row가 됐다 — .one_or_none()이 이 객체를 반환하고 호출부가 속성으로 읽는다."""
    r = MagicMock()
    row = MagicMock()
    for k, v in attrs.items():
        setattr(row, k, v)
    r.one_or_none.return_value = row
    return r


@pytest.mark.anyio
async def test_multiproject_agent_sender_dispatches_without_crash():
    """멀티프로젝트 agent 발신 → sender_type .limit(1)='agent' → dispatch(크래시 0).

    story #2603 P0: agent↔agent 강제 sse/all 바이패스는 제거됐다(channel_router.py docstring
    참조) — 이 테스트의 원래 목적(멀티프로젝트 sender의 team_members 뷰 다중행이 route_message
    를 MultipleResultsFound로 깨지 않는지)은 그대로 지키되, recipient가 명시 멘션된 경우의
    새 기본계약(agent group default: mentions, 멘션 매치로 decision 생성)으로 갱신한다."""
    from app.services.channel_router import route_message

    sender = uuid.uuid4()       # 멀티프로젝트 agent(team_members 뷰 다중행)
    recipient = uuid.uuid4()    # agent 수신자
    conv = uuid.uuid4()
    proj = uuid.uuid4()

    msg = MagicMock()
    msg.id = uuid.uuid4()
    msg.sender_id = sender
    msg.conversation_id = conv
    msg.thread_id = None
    msg.mentioned_ids = [recipient]  # 명시 멘션 — 새 기본계약(mentions) 하에서 decision 발생 조건.

    db = MagicMock()
    db.execute = AsyncMock(side_effect=[
        _scalar(msg),                       # 1 메시지
        _scalar("agent"),                   # 2 sender_type — .limit(1)로 단일 행(뷰 다중에도 안전)
        _scalars([sender, recipient]),      # 3 participants(발신자 포함)
        _scalars([]),                       # 3b story #2349: user_blocker_ids 조회(차단 0건)
        _all([(recipient, "agent")]),       # 4 수신자 type 배치
        _row(project_id=proj, type="group", free_response=False),  # 5 conv project_id/type/free_response
        _scalars([]),                       # 6 preferences
    ])

    with _NOT_EXPIRED, _MENTIONS_ON:
        decisions = await route_message(msg.id, db)
    # 발신자 제외·크래시/ChannelRouterError 없이 멘션된 recipient에게만 decision.
    assert len(decisions) == 1
    assert decisions[0].member_id == recipient
    assert decisions[0].channel == "sse"
    assert decisions[0].level == "mentions"
    assert decisions[0].reason == "agent group default: mentions"


@pytest.mark.anyio
async def test_agent_group_default_excludes_unmentioned_agent_recipient():
    """story #2603 P0 AC1 — 그룹챗에서 멘션 없는 에이전트 발화는 상대 에이전트에게 decision을
    만들지 않는다(= turn 트리거 자체가 없다). 원 접수 루프 시나리오의 핵심 단언."""
    from app.services.channel_router import route_message

    sender = uuid.uuid4()
    recipient = uuid.uuid4()
    conv = uuid.uuid4()
    proj = uuid.uuid4()

    msg = MagicMock()
    msg.id = uuid.uuid4()
    msg.sender_id = sender
    msg.conversation_id = conv
    msg.thread_id = None
    msg.mentioned_ids = []  # 멘션 없음 — 원 루프 재현 시나리오.

    db = MagicMock()
    db.execute = AsyncMock(side_effect=[
        _scalar(msg),
        _scalar("agent"),
        _scalars([sender, recipient]),
        _scalars([]),
        _all([(recipient, "agent")]),
        _row(project_id=proj, type="group", free_response=False),
        _scalars([]),
    ])

    with _NOT_EXPIRED, _MENTIONS_ON:
        decisions = await route_message(msg.id, db)
    assert decisions == [], "멘션 없는데 decision이 생기면 원 루프가 그대로 재현된다"


@pytest.mark.anyio
async def test_agent_group_default_is_all_when_mentions_flag_off():
    """핫픽스(2026-08-13) — settings.agent_group_default_mentions 기본 False에서는 그룹챗
    에이전트 recipient도 멘션 없이 all(사전 #2603 동작 복귀). 팀 전체 A2A 통신 차단 회피가
    이 값의 존재 이유 — 회귀하면 다시 막힌다."""
    from app.services.channel_router import route_message

    sender = uuid.uuid4()
    recipient = uuid.uuid4()
    conv = uuid.uuid4()
    proj = uuid.uuid4()

    msg = MagicMock()
    msg.id = uuid.uuid4()
    msg.sender_id = sender
    msg.conversation_id = conv
    msg.thread_id = None
    msg.mentioned_ids = []  # 멘션 없음 — 플래그 off면 그래도 통과해야 한다.

    db = MagicMock()
    db.execute = AsyncMock(side_effect=[
        _scalar(msg),
        _scalar("agent"),
        _scalars([sender, recipient]),
        _scalars([]),
        _all([(recipient, "agent")]),
        _row(project_id=proj, type="group", free_response=False),
        _scalars([]),
    ])

    with _NOT_EXPIRED:  # _MENTIONS_ON 없음 — 기본값(False) 그대로.
        decisions = await route_message(msg.id, db)
    assert len(decisions) == 1
    assert decisions[0].member_id == recipient
    assert decisions[0].level == "all"
    assert decisions[0].reason == "default: all"


@pytest.mark.anyio
async def test_dm_agent_recipient_defaults_to_all_no_mention_needed():
    """AC2 비회귀 — 1:1(DM) 대화의 에이전트 recipient는 멘션 없이도 기존처럼 all(무회귀)."""
    from app.services.channel_router import route_message

    sender = uuid.uuid4()
    recipient = uuid.uuid4()
    conv = uuid.uuid4()
    proj = uuid.uuid4()

    msg = MagicMock()
    msg.id = uuid.uuid4()
    msg.sender_id = sender
    msg.conversation_id = conv
    msg.thread_id = None
    msg.mentioned_ids = []

    db = MagicMock()
    db.execute = AsyncMock(side_effect=[
        _scalar(msg),
        _scalar("human"),
        _scalars([sender, recipient]),
        _scalars([]),
        _all([(recipient, "agent")]),
        _row(project_id=proj, type="dm", free_response=False),
        _scalars([]),
    ])

    decisions = await route_message(msg.id, db)
    assert len(decisions) == 1
    assert decisions[0].level == "all"
    assert decisions[0].reason == "default: all"


@pytest.mark.anyio
async def test_free_response_conversation_relaxes_mentions_to_all():
    """AC2 옵트아웃 — free_response=true인 그룹 대화는 멘션 없어도 에이전트 recipient에게 간다."""
    from app.services.channel_router import route_message

    sender = uuid.uuid4()
    recipient = uuid.uuid4()
    conv = uuid.uuid4()
    proj = uuid.uuid4()

    msg = MagicMock()
    msg.id = uuid.uuid4()
    msg.sender_id = sender
    msg.conversation_id = conv
    msg.thread_id = None
    msg.mentioned_ids = []

    db = MagicMock()
    db.execute = AsyncMock(side_effect=[
        _scalar(msg),
        _scalar("agent"),
        _scalars([sender, recipient]),
        _scalars([]),
        _all([(recipient, "agent")]),
        _row(project_id=proj, type="group", free_response=True),
        _scalars([]),
    ])

    with _NOT_EXPIRED, _MENTIONS_ON:
        decisions = await route_message(msg.id, db)
    assert len(decisions) == 1
    assert decisions[0].level == "all"
    assert "free_response override" in decisions[0].reason


@pytest.mark.anyio
async def test_explicit_mute_wins_over_free_response_and_mention():
    """mute는 회원 자신의 명시 선택 — free_response 대화든 명시 멘션이든 mute를 못 뒤집는다."""
    from app.services.channel_router import route_message

    sender = uuid.uuid4()
    recipient = uuid.uuid4()
    conv = uuid.uuid4()
    proj = uuid.uuid4()

    msg = MagicMock()
    msg.id = uuid.uuid4()
    msg.sender_id = sender
    msg.conversation_id = conv
    msg.thread_id = None
    msg.mentioned_ids = [recipient]  # 명시 멘션조차도 mute를 못 이긴다.

    db = MagicMock()
    db.execute = AsyncMock(side_effect=[
        _scalar(msg),
        _scalar("agent"),
        _scalars([sender, recipient]),
        _scalars([]),
        _all([(recipient, "agent")]),
        _row(project_id=proj, type="group", free_response=True),
        _scalars([_pref(recipient, scope_type="global", level="mute")]),
    ])

    with _NOT_EXPIRED:
        decisions = await route_message(msg.id, db)
    assert decisions == [], "명시 mute 선택인데 decision이 생기면 회원 자기결정권 위반"


@pytest.mark.anyio
async def test_explicit_all_preference_overrides_agent_group_default():
    """명시 preference 행이 있으면 그게 기본계약(mentions)보다 우선 — 에이전트가 스스로
    all을 선택했다면 그 선택이 존중된다."""
    from app.services.channel_router import route_message

    sender = uuid.uuid4()
    recipient = uuid.uuid4()
    conv = uuid.uuid4()
    proj = uuid.uuid4()

    msg = MagicMock()
    msg.id = uuid.uuid4()
    msg.sender_id = sender
    msg.conversation_id = conv
    msg.thread_id = None
    msg.mentioned_ids = []

    db = MagicMock()
    db.execute = AsyncMock(side_effect=[
        _scalar(msg),
        _scalar("agent"),
        _scalars([sender, recipient]),
        _scalars([]),
        _all([(recipient, "agent")]),
        _row(project_id=proj, type="group", free_response=False),
        _scalars([_pref(recipient, scope_type="global", level="all", channel="sse")]),
    ])

    with _NOT_EXPIRED:
        decisions = await route_message(msg.id, db)
    assert len(decisions) == 1
    assert decisions[0].level == "all"
    assert decisions[0].reason == "preference scope=global"


@pytest.mark.anyio
async def test_chain_expired_blocks_agent_recipient_even_when_mentioned():
    """story #2608 P1 AC1 — A↔B 상호멘션(멘션은 항상 유효)류의 유일한 탈출구. mentions
    체크는 통과해도(recipient가 명시 멘션됨) chain_expired=True + human 참가자 존재면
    최종 게이트에서 막힌다(story #2617 — human 있는 대화는 원 #2608 AC 비회귀)."""
    from app.services.channel_router import route_message

    sender = uuid.uuid4()
    recipient = uuid.uuid4()
    conv = uuid.uuid4()
    proj = uuid.uuid4()

    msg = MagicMock()
    msg.id = uuid.uuid4()
    msg.sender_id = sender
    msg.conversation_id = conv
    msg.thread_id = None
    msg.mentioned_ids = [recipient]  # 유효한 멘션 — 그런데도 막혀야 한다.

    db = MagicMock()
    db.execute = AsyncMock(side_effect=[
        _scalar(msg),
        _scalar("agent"),
        _scalars([sender, recipient]),
        _scalars([]),
        _scalar(uuid.uuid4()),  # story #2617: _conversation_has_human → True(human 존재)
        _all([(recipient, "agent")]),
        _row(project_id=proj, type="group", free_response=False),
        _scalars([]),
    ])

    with patch("app.services.channel_router.compute_agent_chain_depth", AsyncMock(return_value=5)):
        decisions = await route_message(msg.id, db)
    assert decisions == [], "human 있는 대화에서 연쇄 cap 초과인데 멘션 성립만으로 decision이 생기면 P1이 안 먹는다"


@pytest.mark.anyio
async def test_chain_expired_does_not_block_human_less_agent_recipient():
    """story #2617(DM 전용 핫픽스 #3009를 human-presence로 일반화) — human 참가자가 전혀
    없는 대화(DM이든 group이든)는 chain-expired 최종 게이트 밖이다. human 메시지가 없는
    순수 agent 대화는 연쇄 깊이가 구조적으로 늘 cap을 넘는데(장기 협업방 자체가 그런 모양),
    이 게이트가 그대로 적용되면 정상 협업이 통째로 침묵당한다(실제로 페드루↔디디 DM에서
    무멘션 메시지가 전부 막힌 채로 재현됐고, 카디르 QA가 3-agent human-less group에서도
    5번째 메시지부터 동형 재현). human 있는 대화는 위 케이스처럼 그대로 막혀야 한다 — 이
    테스트는 human-less만 예외임을 고정(conv_type=group으로 DM 특칭이 아님을 명시)."""
    from app.services.channel_router import route_message

    sender = uuid.uuid4()
    recipient = uuid.uuid4()
    conv = uuid.uuid4()
    proj = uuid.uuid4()

    msg = MagicMock()
    msg.id = uuid.uuid4()
    msg.sender_id = sender
    msg.conversation_id = conv
    msg.thread_id = None
    msg.mentioned_ids = []  # 무멘션 — human-less 예외(all)만으로 통과해야 한다.

    db = MagicMock()
    db.execute = AsyncMock(side_effect=[
        _scalar(msg),
        _scalar("agent"),
        _scalars([sender, recipient]),
        _scalars([]),
        _scalar(None),  # story #2617: _conversation_has_human → False(human 없음)
        _all([(recipient, "agent")]),
        _row(project_id=proj, type="group", free_response=False),  # DM 아닌 group도 예외 대상
        _scalars([]),
    ])

    with patch("app.services.channel_router.compute_agent_chain_depth", AsyncMock(return_value=999)):
        decisions = await route_message(msg.id, db)
    assert len(decisions) == 1, "human-less 대화에서 연쇄 cap 초과가 무멘션 agent recipient를 막으면 안 된다"
    assert decisions[0].member_id == recipient
    assert decisions[0].level == "all"


@pytest.mark.anyio
async def test_chain_expired_does_not_block_human_recipient():
    """human recipient는 연쇄 게이트 대상이 아니다 — human이 바로 그 개입 대상."""
    from app.services.channel_router import route_message

    sender = uuid.uuid4()
    human_recipient = uuid.uuid4()
    conv = uuid.uuid4()
    proj = uuid.uuid4()

    msg = MagicMock()
    msg.id = uuid.uuid4()
    msg.sender_id = sender
    msg.conversation_id = conv
    msg.thread_id = None
    msg.mentioned_ids = [human_recipient]

    db = MagicMock()
    db.execute = AsyncMock(side_effect=[
        _scalar(msg),
        _scalar("agent"),
        _scalars([sender, human_recipient]),
        _scalars([]),
        _scalar(human_recipient),  # story #2617: _conversation_has_human → True
        _all([(human_recipient, "human")]),
        _row(project_id=proj, type="group", free_response=False),
        _scalars([]),
    ])

    with patch("app.services.channel_router.compute_agent_chain_depth", AsyncMock(return_value=5)):
        decisions = await route_message(msg.id, db)
    assert len(decisions) == 1
    assert decisions[0].member_id == human_recipient


@pytest.mark.anyio
async def test_chain_within_cap_delivers_normally():
    """정상 A2A 협업(깊이 cap 이내)은 비회귀(AC4) — depth가 cap과 같아도(등호 없음) 통과."""
    from app.services.channel_router import route_message, _AGENT_CHAIN_DEPTH_CAP

    sender = uuid.uuid4()
    recipient = uuid.uuid4()
    conv = uuid.uuid4()
    proj = uuid.uuid4()

    msg = MagicMock()
    msg.id = uuid.uuid4()
    msg.sender_id = sender
    msg.conversation_id = conv
    msg.thread_id = None
    msg.mentioned_ids = [recipient]

    db = MagicMock()
    db.execute = AsyncMock(side_effect=[
        _scalar(msg),
        _scalar("agent"),
        _scalars([sender, recipient]),
        _scalars([]),
        _all([(recipient, "agent")]),
        _row(project_id=proj, type="group", free_response=False),
        _scalars([]),
    ])

    with patch(
        "app.services.channel_router.compute_agent_chain_depth",
        AsyncMock(return_value=_AGENT_CHAIN_DEPTH_CAP),
    ):
        decisions = await route_message(msg.id, db)
    assert len(decisions) == 1, "정확히 cap과 같은 깊이(등호)는 아직 유효해야 한다"
