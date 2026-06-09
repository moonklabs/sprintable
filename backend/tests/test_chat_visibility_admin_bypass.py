"""#1262 채팅 가시성 프라이버시 P0 회귀:
admin-bypass(owner/admin org-level 조회)를 **agent-only 대화로 한정**한다.

근본: org owner/admin이 participant 우회로 남의 휴먼↔에이전트 사적 DM을 열람.
정책(PO APPROVE): 참가자에 휴먼이 있으면 private → participant만 조회(owner/admin도 우회 금지).
휴먼 없음(agent-only·팀운영)이면 admin 조회 허용. 본인 참여 대화는 항상 정상.
보수적 human 판별: TeamMember.type='agent'로 확정된 id만 agent, 나머지 전부 human
(grant-only OrgMember·미앵커 휴먼·봉희신류 포함).

테스트 전략:
- 헬퍼(_conversation_has_human_participant / _conversations_with_human_participant)는
  라우팅 mock으로 직접 검증(CP1/CP2/CP3 핵심 로직).
- 3엔드포인트(detail/messages/list) 일관성은 헬퍼 게이트 호출 경로로 검증(CP4/CP5).
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from datetime import datetime, timezone


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _make_conv(*, conv_id, org_id, project_id, conv_type="dm"):
    """ConversationResponse.model_validate가 통과하도록 유효 필드를 가진 conv 객체."""
    from types import SimpleNamespace
    now = datetime(2026, 6, 8, tzinfo=timezone.utc)
    return SimpleNamespace(
        id=conv_id, project_id=project_id, org_id=org_id, type=conv_type,
        title="대화", status="open", created_by=conv_id, created_at=now, updated_at=now,
    )


# ─── 라우팅 mock: 컴파일 statement의 from-entity로 결과 분기 ────────────────────

def _scalars_all(values):
    res = MagicMock()
    res.scalars.return_value.all.return_value = list(values)
    return res


def _rows_all(rows):
    res = MagicMock()
    res.all.return_value = list(rows)
    return res


def _routing_db(*, participant_rows, agent_ids):
    """ConversationParticipant 조회 → participant_rows, TeamMember 조회 → agent_ids 반환.

    participant_rows: [(conversation_id, member_id), ...] (또는 member_id만 필요한 단건 헬퍼용)
    agent_ids: 'agent'로 확정된 TeamMember.id 집합.
    """
    db = AsyncMock()

    async def _execute(stmt, *a, **k):
        sql = str(stmt).lower()
        if "conversation_participants" in sql:
            cols = stmt.selected_columns if hasattr(stmt, "selected_columns") else None
            ncols = len(list(cols)) if cols is not None else 1
            if ncols >= 2:
                # batch 헬퍼: (conversation_id, member_id) 행
                return _rows_all(participant_rows)
            # 단건 헬퍼: member_id만
            return _scalars_all([mid for _, mid in participant_rows])
        if "team_members" in sql:
            # 참가자 중 agent 확정 id
            return _scalars_all(list(agent_ids))
        return _scalars_all([])

    db.execute = AsyncMock(side_effect=_execute)
    return db


# ─── CP1: team_member 휴먼 참가 → private(휴먼 있음) ──────────────────────────

@pytest.mark.anyio
async def test_cp1_team_member_human_is_private():
    """admin 비참가 + team_member 휴먼 참가 대화 → has_human=True(=private·403 폴백)."""
    from app.routers.conversations import _conversation_has_human_participant

    conv = uuid.uuid4()
    human = uuid.uuid4()
    agent = uuid.uuid4()
    db = _routing_db(
        participant_rows=[(conv, human), (conv, agent)],
        agent_ids={agent},  # human은 agent 확정 아님 → human
    )
    assert await _conversation_has_human_participant(conv, db) is True


# ─── CP2: grant-only OrgMember 휴먼(team_member agent 아님) → 보수적 human ──────

@pytest.mark.anyio
async def test_cp2_grant_only_human_conservative_private():
    """grant-only OrgMember 휴먼(봉희신류·team_member agent 아님) 참가 → 보수적으로 human → private."""
    from app.routers.conversations import _conversation_has_human_participant

    conv = uuid.uuid4()
    grant_only_human = uuid.uuid4()  # team_members에 agent로 없음
    agent = uuid.uuid4()
    db = _routing_db(
        participant_rows=[(conv, grant_only_human), (conv, agent)],
        agent_ids={agent},  # grant_only_human은 agent 확정 외 → human
    )
    assert await _conversation_has_human_participant(conv, db) is True


# ─── CP3: agent-only 대화 → admin 조회 허용 ──────────────────────────────────

@pytest.mark.anyio
async def test_cp3_agent_only_allows_admin():
    """참가자 전부 type='agent' → has_human=False(=admin 200 허용)."""
    from app.routers.conversations import _conversation_has_human_participant

    conv = uuid.uuid4()
    a1, a2 = uuid.uuid4(), uuid.uuid4()
    db = _routing_db(
        participant_rows=[(conv, a1), (conv, a2)],
        agent_ids={a1, a2},
    )
    assert await _conversation_has_human_participant(conv, db) is False


@pytest.mark.anyio
async def test_empty_participants_not_private():
    """참가자 없음(엣지) → has_human=False(헬퍼는 admin 폴백 안 함·404/참가체크는 호출부 책임)."""
    from app.routers.conversations import _conversation_has_human_participant

    conv = uuid.uuid4()
    db = _routing_db(participant_rows=[], agent_ids=set())
    assert await _conversation_has_human_participant(conv, db) is False


# ─── CP5: batch 헬퍼(list_conversations) — agent-only만 통과 ──────────────────

@pytest.mark.anyio
async def test_cp5_batch_excludes_human_convs():
    """conv_ids 중 휴먼 참가 대화만 human-set에 — agent-only는 제외(admin에게 추가 노출)."""
    from app.routers.conversations import _conversations_with_human_participant

    conv_human = uuid.uuid4()   # 휴먼 참가 (private)
    conv_agent = uuid.uuid4()   # agent-only
    human = uuid.uuid4()
    a1, a2, a3 = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    db = _routing_db(
        participant_rows=[
            (conv_human, human), (conv_human, a1),
            (conv_agent, a2), (conv_agent, a3),
        ],
        agent_ids={a1, a2, a3},  # human만 agent 확정 외
    )
    human_set = await _conversations_with_human_participant([conv_human, conv_agent], db)
    assert human_set == {conv_human}  # private만 — agent-only는 admin 노출 허용


@pytest.mark.anyio
async def test_cp5_batch_empty_input():
    """빈 입력 → 빈 집합(쿼리 없음)."""
    from app.routers.conversations import _conversations_with_human_participant

    db = AsyncMock()
    db.execute = AsyncMock(side_effect=AssertionError("should not query on empty input"))
    assert await _conversations_with_human_participant([], db) == set()


# ─── CP4 + 3엔드포인트 일관성: detail/messages가 휴먼 참가 시 participant 폴백 ──

def _admin_routing_db(*, conv, project_id, participant_member_ids, agent_ids, admin_role="admin",
                      requester_is_participant):
    """detail/messages 엔드포인트 통합 mock.

    - Conversation 조회 → conv (project_id 포함)
    - _resolve_member(TeamMember) → admin sender
    - _effective_org_role(OrgMember.role) → admin_role
    - 헬퍼 participant/agent 조회 → human 판별
    - participant 체크 → requester_is_participant
    """
    sender = MagicMock()
    sender.id = uuid.uuid4()
    sender.role = "member"  # raw project role 낮음 — org에서 admin 상속
    sender.type = "human"
    sender.name = "admin user"

    async def _execute(stmt, *a, **k):
        sql = str(stmt).lower()
        # Conversation 단건 조회(participant 테이블 미포함 + conversations FROM)
        if "from conversations" in sql and "conversation_participants" not in sql:
            res = MagicMock()
            res.scalar_one_or_none.return_value = conv
            return res
        if "org_members" in sql:
            res = MagicMock()
            res.scalar_one_or_none.return_value = admin_role
            return res
        if "team_members" in sql and "conversation_participants" not in sql:
            # 두 용도: _resolve_member(sender) 또는 헬퍼 agent 확정
            if "type" in sql and ("in (" in sql or "in(" in sql):
                return _scalars_all(list(agent_ids))
            res = MagicMock()
            res.scalars.return_value.first.return_value = sender
            return res
        if "conversation_participants" in sql:
            cols = stmt.selected_columns if hasattr(stmt, "selected_columns") else None
            ncols = len(list(cols)) if cols is not None else 1
            if ncols >= 2:
                return _rows_all([(conv.id, mid) for mid in participant_member_ids])
            # 단건: member_id 헬퍼 또는 participant 체크
            # participant 체크는 scalar_one_or_none 사용 → 별도 분기
            res = MagicMock()
            res.scalars.return_value.all.return_value = list(participant_member_ids)
            res.scalar_one_or_none.return_value = (uuid.uuid4() if requester_is_participant else None)
            return res
        res = MagicMock()
        res.scalars.return_value.all.return_value = []
        res.scalar_one_or_none.return_value = None
        return res

    db = AsyncMock()
    db.execute = AsyncMock(side_effect=_execute)
    return db, sender


@pytest.mark.anyio
async def test_cp4_admin_own_participation_passes_detail():
    """CP4: admin이 휴먼 참가 대화에 본인도 참가 → 정상 통과(403 아님)."""
    from app.routers.conversations import get_conversation
    from app.dependencies.auth import AuthContext  # noqa: F401

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    conv = _make_conv(conv_id=uuid.uuid4(), org_id=org_id, project_id=project_id, conv_type="dm")

    human = uuid.uuid4()
    agent = uuid.uuid4()
    db, sender = _admin_routing_db(
        conv=conv, project_id=project_id,
        participant_member_ids=[human, agent], agent_ids={agent},
        requester_is_participant=True,  # admin 본인 참가
    )
    auth = MagicMock()
    auth.user_id = str(uuid.uuid4())
    auth.claims = {"app_metadata": {}}

    # participant이므로 403 안 남
    resp = await get_conversation(conv.id, db=db, auth=auth, org_id=org_id)  # type: ignore[arg-type]
    assert resp is not None


@pytest.mark.anyio
async def test_cp4_admin_nonparticipant_human_conv_403_detail():
    """CP1/CP5(detail): admin 비참가 + 휴먼 참가 대화 → 403(private participant only)."""
    from fastapi import HTTPException
    from app.routers.conversations import get_conversation

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    conv = _make_conv(conv_id=uuid.uuid4(), org_id=org_id, project_id=project_id, conv_type="dm")

    human = uuid.uuid4()
    agent = uuid.uuid4()
    db, sender = _admin_routing_db(
        conv=conv, project_id=project_id,
        participant_member_ids=[human, agent], agent_ids={agent},
        requester_is_participant=False,  # admin 비참가
    )
    auth = MagicMock()
    auth.user_id = str(uuid.uuid4())
    auth.claims = {"app_metadata": {}}

    with pytest.raises(HTTPException) as ei:
        await get_conversation(conv.id, db=db, auth=auth, org_id=org_id)  # type: ignore[arg-type]
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_cp3_admin_nonparticipant_agent_only_conv_200_detail():
    """CP3(detail): admin 비참가 + agent-only 대화 → 통과(admin-bypass 허용)."""
    from app.routers.conversations import get_conversation

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    conv = _make_conv(conv_id=uuid.uuid4(), org_id=org_id, project_id=project_id, conv_type="group")

    a1, a2 = uuid.uuid4(), uuid.uuid4()
    db, sender = _admin_routing_db(
        conv=conv, project_id=project_id,
        participant_member_ids=[a1, a2], agent_ids={a1, a2},  # agent-only
        requester_is_participant=False,  # admin 비참가지만 agent-only → 허용
    )
    auth = MagicMock()
    auth.user_id = str(uuid.uuid4())
    auth.claims = {"app_metadata": {}}

    resp = await get_conversation(conv.id, db=db, auth=auth, org_id=org_id)  # type: ignore[arg-type]
    assert resp is not None


def _messages_routing_db(*, conv_id, project_id, participant_member_ids, agent_ids,
                         admin_role="admin", requester_is_participant):
    """list_messages 엔드포인트 mock — Conversation.project_id는 스칼라 컬럼 조회."""
    sender = MagicMock()
    sender.id = uuid.uuid4()
    sender.role = "member"
    sender.type = "human"
    sender.name = "admin user"

    async def _execute(stmt, *a, **k):
        sql = str(stmt).lower()
        if "from conversations" in sql and "conversation_participants" not in sql:
            res = MagicMock()
            res.scalar_one_or_none.return_value = project_id
            return res
        if "org_members" in sql:
            res = MagicMock()
            res.scalar_one_or_none.return_value = admin_role
            return res
        if "team_members" in sql and "conversation_participants" not in sql:
            if "type" in sql and ("in (" in sql or "in(" in sql):
                return _scalars_all(list(agent_ids))
            res = MagicMock()
            res.scalars.return_value.first.return_value = sender
            return res
        if "conversation_participants" in sql:
            cols = stmt.selected_columns if hasattr(stmt, "selected_columns") else None
            ncols = len(list(cols)) if cols is not None else 1
            if ncols >= 2:
                return _rows_all([(conv_id, mid) for mid in participant_member_ids])
            res = MagicMock()
            res.scalars.return_value.all.return_value = list(participant_member_ids)
            res.scalar_one_or_none.return_value = (uuid.uuid4() if requester_is_participant else None)
            return res
        if "conversation_messages" in sql:
            return _scalars_all([])  # 메시지 없음(게이트 통과 후 빈 목록)
        res = MagicMock()
        res.scalars.return_value.all.return_value = []
        res.scalar_one_or_none.return_value = None
        return res

    db = AsyncMock()
    db.execute = AsyncMock(side_effect=_execute)
    return db, sender


@pytest.mark.anyio
async def test_cp5_messages_admin_nonparticipant_human_conv_403():
    """CP5(messages 일관): admin 비참가 + 휴먼 참가 대화 → 403(detail과 동형)."""
    from fastapi import HTTPException
    from app.routers.conversations import list_messages

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    conv_id = uuid.uuid4()
    human, agent = uuid.uuid4(), uuid.uuid4()
    db, sender = _messages_routing_db(
        conv_id=conv_id, project_id=project_id,
        participant_member_ids=[human, agent], agent_ids={agent},
        requester_is_participant=False,
    )
    auth = MagicMock()
    auth.user_id = str(uuid.uuid4())
    auth.claims = {"app_metadata": {}}

    with pytest.raises(HTTPException) as ei:
        await list_messages(conv_id, db=db, auth=auth, org_id=org_id)  # type: ignore[arg-type]
    assert ei.value.status_code == 403


@pytest.mark.anyio
async def test_cp5_messages_admin_nonparticipant_agent_only_ok():
    """CP5(messages 일관): admin 비참가 + agent-only 대화 → 통과(admin-bypass 허용)."""
    from app.routers.conversations import list_messages

    org_id = uuid.uuid4()
    project_id = uuid.uuid4()
    conv_id = uuid.uuid4()
    a1, a2 = uuid.uuid4(), uuid.uuid4()
    db, sender = _messages_routing_db(
        conv_id=conv_id, project_id=project_id,
        participant_member_ids=[a1, a2], agent_ids={a1, a2},
        requester_is_participant=False,
    )
    auth = MagicMock()
    auth.user_id = str(uuid.uuid4())
    auth.claims = {"app_metadata": {}}

    resp = await list_messages(conv_id, limit=30, before=None, thread_id=None,
                               db=db, auth=auth, org_id=org_id)  # type: ignore[arg-type]
    assert resp["data"] == []  # 게이트 통과 → 빈 메시지 목록
