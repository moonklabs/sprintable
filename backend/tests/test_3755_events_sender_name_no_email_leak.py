"""story #3755(BE·표시명·결함 클래스, 별건 ④) — GET /events/definitions/publish-history의
sender_name(EventPublishHistoryItem) 응답 필드 회귀 pin. 그라운딩 당시(Pedro 1차 인용은
events.py:405·742였으나 둘 다 `.name`을 안 읽는 자리였다 — 코드 재확認으로 정정) 실제
새는 자리는 여기(get_event_publish_history, events.py:~2810)였다: `lookup_members_by_ids`
결과의 `.name`을 그대로 sender_name에 흘려보내는데, 이 이름이 member_resolver.py의
email/id 폴백 버그를 그대로 물려받고 있었다 — #3755 5자리 fix로 그 폴백이 걷혔으니, 이
엔드포인트가 실제로 그 정직한 None을 그대로 통과시키는지(스스로 새 폴백을 지어내지
않는지)를 고정한다.

라우터가 `lookup_members_by_ids`를 함수 안에서 로컬 import하므로 그 원본 모듈
(app.services.member_resolver)을 몽키패치한다 — 함수 호출 시점에 재바인딩되어 동작."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
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


def _fake_message_row(*, id_, conversation_id, sender_id, created_at):
    row = MagicMock()
    row.id = id_
    row.conversation_id = conversation_id
    row.sender_id = sender_id
    row.created_at = created_at
    return row


@pytest.mark.anyio
async def test_publish_history_sender_name_passes_through_none_no_email_fabricated(monkeypatch):
    """양성대조(display_name NULL 사용자) — resolver가 name=None을 돌리면 응답도 None
    그대로(라우터가 스스로 email/id로 채우지 않는다)."""
    import app.routers.events as events_router
    import app.services.member_resolver as mr
    from app.services.member_resolver import ResolvedMember

    org_id = uuid.uuid4()
    admin_id = uuid.uuid4()
    sender_id = uuid.uuid4()
    msg_id = uuid.uuid4()
    conv_id = uuid.uuid4()

    monkeypatch.setattr(events_router, "_is_org_admin", AsyncMock(return_value=True))

    db = AsyncMock()
    rows_result = MagicMock()
    rows_result.scalars.return_value.all.return_value = [
        _fake_message_row(id_=msg_id, conversation_id=conv_id, sender_id=sender_id, created_at=datetime.now(tz=timezone.utc)),
    ]
    db.execute = AsyncMock(return_value=rows_result)

    async def _fake_lookup(ids, session):
        assert sender_id in ids
        return {sender_id: ResolvedMember(
            id=sender_id, user_id=uuid.uuid4(), name=None, type="human", role="member", org_id=org_id,
        )}

    monkeypatch.setattr(mr, "lookup_members_by_ids", _fake_lookup)

    result = await events_router.get_event_publish_history(
        definition_key="preset.gate.verdict", limit=20,
        db=db, auth=_auth(admin_id), org_id=org_id,
    )

    assert len(result) == 1
    # ⭐되돌리면 RED — resolver name=None인데도 이 필드가 email 문자열이거나 "@"를 담으면
    # 그건 라우터(또는 그 상위 resolver)가 폴백을 지어낸다는 뜻.
    assert result[0].sender_name is None
    assert "@" not in (result[0].sender_name or "")


@pytest.mark.anyio
async def test_publish_history_sender_name_real_name_passes_through(monkeypatch):
    """대조 — resolver가 실명을 주면 그대로 나온다(이 테스트가 «뭘 넣어도 None»인 허수아비가
    아님을 증명)."""
    import app.routers.events as events_router
    import app.services.member_resolver as mr
    from app.services.member_resolver import ResolvedMember

    org_id = uuid.uuid4()
    admin_id = uuid.uuid4()
    sender_id = uuid.uuid4()
    msg_id = uuid.uuid4()
    conv_id = uuid.uuid4()

    monkeypatch.setattr(events_router, "_is_org_admin", AsyncMock(return_value=True))

    db = AsyncMock()
    rows_result = MagicMock()
    rows_result.scalars.return_value.all.return_value = [
        _fake_message_row(id_=msg_id, conversation_id=conv_id, sender_id=sender_id, created_at=datetime.now(tz=timezone.utc)),
    ]
    db.execute = AsyncMock(return_value=rows_result)

    async def _fake_lookup(ids, session):
        return {sender_id: ResolvedMember(
            id=sender_id, user_id=uuid.uuid4(), name="페드루 올리베이라", type="human", role="member", org_id=org_id,
        )}

    monkeypatch.setattr(mr, "lookup_members_by_ids", _fake_lookup)

    result = await events_router.get_event_publish_history(
        definition_key="preset.gate.verdict", limit=20,
        db=db, auth=_auth(admin_id), org_id=org_id,
    )

    assert result[0].sender_name == "페드루 올리베이라"
