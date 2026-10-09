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


def test_no_sender_means_null_even_if_the_payload_carries_a_value():
    frame = _event_to_payload(_event(None, {"sender_org_id": str(ORG_B)}))
    assert frame["sender_org_id"] is None


def test_an_old_row_without_the_field_is_null_not_the_row_org():
    frame = _event_to_payload(_event(SENDER, {"content": "old row"}, org=ORG_A))
    assert frame["sender_org_id"] is None


def test_sender_org_of_a_real_member_and_of_the_orphan_sentinel():
    assert sender_org_id_of(SimpleNamespace(org_id=ORG_A)) == str(ORG_A)
    assert sender_org_id_of(SimpleNamespace(org_id=uuid.UUID(int=0))) is None
    assert sender_org_id_of(SimpleNamespace(org_id="not-a-uuid")) is None
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


def test_backfill_frame_leads_with_the_stream_org_and_the_sender_org():
    from app.routers.events import _backfill_frame_data

    frame = _backfill_frame_data(_event(SENDER, {"gate_id": "g1"}), ORG_B)
    assert list(frame)[:2] == ["stream_org_id", "sender_org_id"], "both fields lead the frame"
    assert frame["stream_org_id"] == str(ORG_B), "the org that authenticated this stream"
    assert frame["sender_org_id"] is None, "a backfill frame does not look the sender up: null"
    assert frame["gate_id"] == "g1", "the payload keys still lift to the top"


def test_a_forged_sender_org_in_a_stored_payload_is_never_used():
    from app.routers.events import _backfill_frame_data

    frame = _backfill_frame_data(_event(SENDER, {"sender_org_id": str(ORG_B), "stream_org_id": str(ORG_B)}, org=ORG_A), ORG_A)
    assert frame["sender_org_id"] is None, "the payload's value is not trusted, even for another org"
    assert frame["stream_org_id"] == str(ORG_A), "the stream's own org, not the payload's"


def test_a_live_frame_keeps_only_a_real_uuid_sender_org():
    from app.routers.events import _with_stream_org

    assert _with_stream_org({"sender_org_id": str(ORG_A)}, ORG_B)["sender_org_id"] == str(ORG_A)
    assert _with_stream_org({"sender_org_id": "not-a-uuid"}, ORG_B)["sender_org_id"] is None
    assert _with_stream_org({"sender_org_id": ["list"]}, ORG_B)["sender_org_id"] is None
    assert _with_stream_org({"sender_org_id": str(uuid.UUID(int=0))}, ORG_B)["sender_org_id"] is None, "the sentinel is no org"


def test_a_payload_or_frame_cannot_fake_the_stream_org():
    from app.routers.events import _backfill_frame_data, _with_stream_org

    frame = _backfill_frame_data(_event(SENDER, {"stream_org_id": str(ORG_A)}), ORG_B)
    assert frame["stream_org_id"] == str(ORG_B), "the stream's org wins over a payload's own key"
    live = _with_stream_org({"stream_org_id": str(ORG_A), "event_id": "e1", "content": "hi"}, ORG_B)
    assert live["stream_org_id"] == str(ORG_B)
    assert live["sender_org_id"] is None, "a live frame with no sender org says null, not nothing"
    assert list(live)[:2] == ["stream_org_id", "sender_org_id"]


def test_no_stream_org_is_null_not_missing():
    from app.routers.events import _with_stream_org

    frame = _with_stream_org({"event_id": "e2"}, None)
    assert frame["stream_org_id"] is None and "stream_org_id" in frame


def test_the_stream_stamps_its_own_org_on_both_live_and_backfill_frames():
    import inspect

    from app.routers import events as ev_module

    source = inspect.getsource(ev_module.agent_event_stream)
    assert "_with_stream_org(event_data, org_id)" in source, "the live frame carries the stream's org"
    assert "_backfill_frame_data(evt, org_id, sender_orgs) for evt in batch" in source, "the backfill frame carries it too"
    assert "sender_orgs = await _sender_orgs_for(db, batch)" in source, "the backfill batch looks its senders up once"


def test_a_backfill_batch_looks_the_senders_up_once_and_names_their_own_org():
    import asyncio
    from unittest.mock import patch

    from app.routers import events as ev_module

    other = uuid.UUID("44444444-4444-4444-8444-444444444444")
    members = {
        SENDER: SimpleNamespace(org_id=ORG_B),       # a sender of another org
        other: SimpleNamespace(org_id=uuid.UUID(int=0)),  # orphan sentinel: no org
    }
    calls: list[set] = []

    async def fake_lookup(ids, session):
        calls.append(set(ids))
        return {i: members[i] for i in ids if i in members}

    batch = [_event(SENDER, {}, org=ORG_A), _event(SENDER, {}, org=ORG_A), _event(other, {}, org=ORG_A), _event(None, {}, org=ORG_A)]
    with patch.object(ev_module, "lookup_members_by_ids", side_effect=fake_lookup):
        orgs = asyncio.run(ev_module._sender_orgs_for(object(), batch))
    assert len(calls) == 1, "one lookup for the whole batch, not one per event"
    assert calls[0] == {SENDER, other}, "distinct senders only, none for the sender-less event"
    assert orgs == {str(SENDER): str(ORG_B), str(other): None}

    frame = ev_module._backfill_frame_data(batch[0], ORG_A, orgs)
    assert frame["sender_org_id"] == str(ORG_B), "the sender's own org, not the stream's or the row's"
    assert frame["stream_org_id"] == str(ORG_A)
    assert ev_module._backfill_frame_data(batch[2], ORG_A, orgs)["sender_org_id"] is None, "orphan: null"
    assert ev_module._backfill_frame_data(batch[3], ORG_A, orgs)["sender_org_id"] is None, "no sender: null"


def test_a_forged_payload_is_ignored_even_when_the_lookup_has_an_answer():
    from app.routers.events import _backfill_frame_data

    frame = _backfill_frame_data(_event(SENDER, {"sender_org_id": str(ORG_A)}, org=ORG_A), ORG_A, {str(SENDER): str(ORG_B)})
    assert frame["sender_org_id"] == str(ORG_B), "the lookup's answer wins over the stored payload"
