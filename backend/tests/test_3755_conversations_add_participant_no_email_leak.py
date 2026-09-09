"""story #3755(BE·표시명·결함 클래스, 별건 ④) — POST /conversations/{id}/participants 응답
name 필드(add_participant, conversations.py:~2366·2382 `"name": target.name`) 회귀 pin.

이 엔드포인트는 `resolve_member_identity()`의 반환값을 그대로 응답에 흘려보낸다(라우터
자체엔 폴백 로직이 없다) — resolve_member_identity 자체의 정직성은
test_3755_member_resolver_no_email_leak.py가 이미 mutation-kill로 고정했으므로, 이
파일의 역할은 **그 정직한 값을 라우터가 다시 지어내지 않고 그대로 통과시키는지**만
좁게 본다. 저수준 SQL은 몽키패치로 우회하고(_resolve_member·resolve_member_identity·
_enforce_agent_creator_policy 셋을 직접 대체) 응답 계약만 관측한다."""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _auth(user_id: uuid.UUID) -> MagicMock:
    ctx = MagicMock()
    ctx.user_id = str(user_id)
    ctx.claims = {"app_metadata": {}}
    return ctx


def _sql_result(*, scalar=None, all_=None):
    r = MagicMock()
    r.scalar_one_or_none.return_value = scalar
    r.scalars.return_value.all.return_value = all_ if all_ is not None else []
    return r


@pytest.mark.anyio
async def test_add_participant_group_branch_name_passes_through_none(monkeypatch):
    """양성대조(display_name NULL 대상) — resolve_member_identity가 name=None을 돌리면
    add_participant 응답도 None 그대로(라우터가 스스로 email/id로 채우지 않는다)."""
    import app.routers.conversations as conv_router
    from app.models.conversation import Conversation
    from app.services.member_resolver import ResolvedMember

    org_id = uuid.uuid4()
    sender_id = uuid.uuid4()
    target_id = uuid.uuid4()
    conv_id = uuid.uuid4()

    conv = MagicMock(spec=Conversation)
    conv.id = conv_id
    conv.type = "group"
    conv.project_id = None
    conv.org_id = org_id

    sender = ResolvedMember(id=sender_id, user_id=uuid.uuid4(), name="발신자", type="human", role="member", org_id=org_id)
    target = ResolvedMember(id=target_id, user_id=uuid.uuid4(), name=None, type="human", role="member", org_id=org_id)

    monkeypatch.setattr(conv_router, "_resolve_member", AsyncMock(return_value=sender))
    monkeypatch.setattr(conv_router, "resolve_member_identity", AsyncMock(return_value=target))
    monkeypatch.setattr(conv_router, "_enforce_agent_creator_policy", AsyncMock(return_value=None))

    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[
        _sql_result(scalar=conv),           # select(Conversation)
        _sql_result(scalar=sender_id),      # is_participant 확인 — sender 본인 참여 중
        _sql_result(all_=[sender_id]),      # 기존 참여자 id 목록(_enforce_agent_creator_policy 인자용)
    ])
    db.add = MagicMock()
    db.commit = AsyncMock()

    from app.routers.conversations import AddParticipantRequest

    result = await conv_router.add_participant(
        conversation_id=conv_id,
        body=AddParticipantRequest(member_id=target_id),
        db=db, auth=_auth(sender_id), org_id=org_id,
    )

    assert result["forked"] is False
    # ⭐되돌리면 RED — resolve_member_identity가 name=None인데도 응답이 email이거나 "@"를
    # 담으면 라우터가 폴백을 지어낸다는 뜻.
    assert result["name"] is None
    assert "@" not in (result["name"] or "")


@pytest.mark.anyio
async def test_add_participant_group_branch_real_name_passes_through(monkeypatch):
    """대조 — resolve_member_identity가 실명을 주면 그대로 나온다(허수아비 방지)."""
    import app.routers.conversations as conv_router
    from app.models.conversation import Conversation
    from app.services.member_resolver import ResolvedMember

    org_id = uuid.uuid4()
    sender_id = uuid.uuid4()
    target_id = uuid.uuid4()
    conv_id = uuid.uuid4()

    conv = MagicMock(spec=Conversation)
    conv.id = conv_id
    conv.type = "group"
    conv.project_id = None
    conv.org_id = org_id

    sender = ResolvedMember(id=sender_id, user_id=uuid.uuid4(), name="발신자", type="human", role="member", org_id=org_id)
    target = ResolvedMember(id=target_id, user_id=uuid.uuid4(), name="새 참여자", type="human", role="member", org_id=org_id)

    monkeypatch.setattr(conv_router, "_resolve_member", AsyncMock(return_value=sender))
    monkeypatch.setattr(conv_router, "resolve_member_identity", AsyncMock(return_value=target))
    monkeypatch.setattr(conv_router, "_enforce_agent_creator_policy", AsyncMock(return_value=None))

    db = AsyncMock()
    db.execute = AsyncMock(side_effect=[
        _sql_result(scalar=conv),
        _sql_result(scalar=sender_id),
        _sql_result(all_=[sender_id]),
    ])
    db.add = MagicMock()
    db.commit = AsyncMock()

    from app.routers.conversations import AddParticipantRequest

    result = await conv_router.add_participant(
        conversation_id=conv_id,
        body=AddParticipantRequest(member_id=target_id),
        db=db, auth=_auth(sender_id), org_id=org_id,
    )

    assert result["name"] == "새 참여자"
