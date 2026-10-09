"""story 4649 — 에이전트 스트림 프레임에 보낸 이의 조직(`sender_org_id`)이 실린다.

- 발신 때 채팅 메시지 payload에 발신자 조직이 실린다(`_msg_payload`) → 라이브 프레임 최상위 · 저장된 payload에 같이 남는다.
- 백필 프레임(`_event_to_payload`)은 그 값을 최상위로 올린다. 발신자 없는 이벤트·값 없는 옛 행은 null.
- 주인 없는 sentinel(uuid 0)은 조직이 아니므로 null.
되돌리면(필드 제거 · 행의 org_id로 바꿈) 아래 시험이 빨개진다.
"""
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from app.routers.conversations import _msg_payload, sender_org_id_of
from app.routers.events import _event_to_payload

ORG_A = uuid.UUID("11111111-1111-4111-8111-111111111111")
ORG_B = uuid.UUID("22222222-2222-4222-8222-222222222222")
SENDER = uuid.UUID("33333333-3333-4333-8333-333333333333")


def _event(sender_id, payload, org=ORG_A):
    return SimpleNamespace(
        id=uuid.uuid4(), event_type="conversation.message_created", source_entity_type="conversation_message",
        source_entity_id=uuid.uuid4(), sender_id=sender_id, org_id=org, payload=payload,
        created_at=datetime(2026, 10, 10, tzinfo=timezone.utc), created_xid=None,
    )


def test_backfill_frame_carries_the_senders_org_at_the_top():
    frame = _event_to_payload(_event(SENDER, {"sender_org_id": str(ORG_B), "content": "hi"}))
    assert frame["sender_org_id"] == str(ORG_B), "the sender's org, not the row's org (ORG_A)"
    assert list(frame)[0] == "sender_org_id", "first key of the frame"


def test_no_sender_means_null_even_if_the_payload_carries_a_value():
    frame = _event_to_payload(_event(None, {"sender_org_id": str(ORG_B)}))
    assert frame["sender_org_id"] is None


def test_an_old_row_without_the_field_is_null_not_the_row_org():
    frame = _event_to_payload(_event(SENDER, {"content": "old row"}, org=ORG_A))
    assert frame["sender_org_id"] is None


def test_sender_org_of_a_real_member_and_of_the_orphan_sentinel():
    assert sender_org_id_of(SimpleNamespace(org_id=ORG_A)) == str(ORG_A)
    assert sender_org_id_of(SimpleNamespace(org_id=uuid.UUID(int=0))) is None
    assert sender_org_id_of(None) is None


def test_chat_message_payload_names_the_sender_org_once():
    msg = SimpleNamespace(
        id=uuid.uuid4(), conversation_id=uuid.uuid4(), thread_id=None, reply_count=0, last_reply_at=None,
        deleted_at=None, content="안녕", mentioned_ids=[], attachments=[], created_at=datetime(2026, 10, 10, tzinfo=timezone.utc),
    )
    sender = SimpleNamespace(id=SENDER, name="발신", type="agent", avatar_url=None, org_id=ORG_A, runtime_type="claude-code")
    payload = _msg_payload(msg, sender)
    assert payload["sender_org_id"] == str(ORG_A)
    assert payload["sender"]["id"] == str(SENDER)
