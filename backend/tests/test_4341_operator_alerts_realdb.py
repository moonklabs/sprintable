"""story #4341 — 플랫폼 운영 알림(operator_alerts) 실 PG 검증.

AC1: 설정된 운영 대화로 메시지를 보내고 전달 결과를 돌려준다 · 미설정이면 «전달 안 됨»(pending으로 남음) · 같은 사건 두 번(동시 포함)이면
메시지 1 · 전달 실패는 재시도(비종결). PO 조건: 재시도 틱은 정해진 몫(건수 · 초) 안에서만 · 메시지 · 표에 민감값 0 · delivered는
메시지 행이 커밋된 뒤에만.

unique · FOR UPDATE · 커밋 경계는 mock으로 못 본다 — alembic-migrated 실 PG가 필요하다(URL 없으면 skip).
"""
from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager
from unittest.mock import patch

import pytest
from sqlalchemy import select

from app.services import operator_alerts
from app.services.operator_alerts import (
    notify_operator,
    process_due_operator_alerts,
    sanitize_alert_fields,
)
from tests.test_1994_backlink_api_realdb import (
    _make_org,
    _make_project,
    _session_factory,
)
from tests.test_2288_command_center_gate_type_waiting_realdb import _make_member
from tests.test_2301_story_body_mentions_realdb import _REAL_DB_URL

pytestmark = [
    pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요"),
    pytest.mark.anyio,
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
async def _dispose_global_engine_after_test():
    yield
    from app.core.database import engine as _global_engine
    await _global_engine.dispose()


@asynccontextmanager
async def _ops_db():
    """(Session, ops 대화 id). 운영 대화 = 사람 한 명이 있는 group 대화(에이전트 발신 서킷브레이커는 사람 없는 대화만 막는다).
    엔진은 테스트 본문의 이벤트 루프에서 만든다(async fixture로 만들면 다른 루프에 묶인다)."""
    from app.models.conversation import Conversation, ConversationParticipant

    engine, Session = await _session_factory()
    try:
        async with Session() as s:
            org = await _make_org(s)
            project = await _make_project(s, org.id)
            human_id, _ = await _make_member(s, org.id, project.id)
            conv = Conversation(id=uuid.uuid4(), project_id=project.id, org_id=org.id, type="group", title="운영", created_by=human_id)
            s.add(conv)
            await s.flush()
            s.add(ConversationParticipant(conversation_id=conv.id, member_id=human_id))
            await s.commit()
            conv_id = conv.id
        # 커밋 뒤 배달(background task)이 모듈 전역 세션 팩토리로 여는 연결을 이 테스트 DB로(test_2829 관례).
        with patch("app.core.database.async_session_factory", Session):
            yield Session, conv_id
    finally:
        await engine.dispose()


def _configure(monkeypatch, conv_id):
    from app.core.config import settings

    monkeypatch.setattr(settings, "ops_alert_conversation_id", str(conv_id) if conv_id else "")


def _key() -> str:
    return f"test.4341:{uuid.uuid4()}"


async def _alert(Session, key):
    from app.models.operator_alert import OperatorAlert

    async with Session() as s:
        return (await s.execute(select(OperatorAlert).where(OperatorAlert.dedupe_key == key))).scalar_one_or_none()


async def _alert_messages(Session, conv_id, key):
    from app.models.conversation import ConversationMessage

    async with Session() as s:
        rows = (await s.execute(select(ConversationMessage).where(ConversationMessage.conversation_id == conv_id))).scalars().all()
    return [m for m in rows if ((m.msg_metadata or {}).get("event") or {}).get("ops_alert", {}).get("dedupe_key") == key]


async def test_delivers_once_and_marks_delivered_with_message(monkeypatch):
    async with _ops_db() as db:
        Session, conv_id = db
        _configure(monkeypatch, conv_id)
        key = _key()
        org_id = uuid.uuid4()
        result = await notify_operator(
            kind="billing.late_charge", dedupe_key=key, target_org_id=org_id,
            target={"attempt_id": uuid.UUID(int=7)}, facts={"amount_minor": 99000, "code": "LATE_CHARGE"}, session_factory=Session,
        )
        assert (result.delivered, result.reason) == (True, "delivered")
        alert = await _alert(Session, key)
        assert alert.status == "delivered" and alert.message_id is not None and alert.delivered_at is not None
        msgs = await _alert_messages(Session, conv_id, key)
        assert [m.id for m in msgs] == [alert.message_id], "delivered는 커밋된 그 메시지 행을 가리킨다"
        assert "billing.late_charge" in msgs[0].content and "amount_minor=99000" in msgs[0].content

        again = await notify_operator(kind="billing.late_charge", dedupe_key=key, session_factory=Session)
        assert (again.delivered, again.reason) == (True, "already_delivered")
        assert len(await _alert_messages(Session, conv_id, key)) == 1, "같은 사건 두 번째 호출은 메시지를 만들지 않는다"


async def test_concurrent_same_event_yields_one_message(monkeypatch):
    async with _ops_db() as db:
        Session, conv_id = db
        _configure(monkeypatch, conv_id)
        key = _key()
        results = await asyncio.gather(*[
            notify_operator(kind="billing.refund_failed", dedupe_key=key, session_factory=Session) for _ in range(4)
        ])
        assert all(r.delivered for r in results)
        assert sorted(r.reason for r in results).count("delivered") == 1
        assert len(await _alert_messages(Session, conv_id, key)) == 1


async def test_not_configured_is_not_delivered_and_stays_pending_then_retry_delivers(monkeypatch):
    async with _ops_db() as db:
        Session, conv_id = db
        _configure(monkeypatch, None)
        key = _key()
        result = await notify_operator(kind="billing.late_charge", dedupe_key=key, session_factory=Session)
        assert (result.delivered, result.reason) == (False, "not_configured"), "받는 곳이 없으면 거짓 성공 0"
        alert = await _alert(Session, key)
        assert (alert.status, alert.last_error, alert.message_id) == ("pending", "not_configured", None)

        skipped = await process_due_operator_alerts(session_factory=Session)
        assert skipped.get("skipped") == "not_configured"

        _configure(monkeypatch, conv_id)
        await process_due_operator_alerts(session_factory=Session)
        alert = await _alert(Session, key)
        assert alert.status == "delivered"
        assert len(await _alert_messages(Session, conv_id, key)) == 1


async def test_send_failure_is_non_terminal_backs_off_and_retry_delivers(monkeypatch):
    async with _ops_db() as db:
        from datetime import datetime, timezone

        from app.models.operator_alert import OperatorAlert

        Session, conv_id = db
        _configure(monkeypatch, conv_id)
        key = _key()

        async def boom(*_a, **_k):
            raise RuntimeError("send down")

        with patch.object(operator_alerts, "_send", boom):
            result = await notify_operator(kind="billing.late_charge", dedupe_key=key, session_factory=Session)
        assert (result.delivered, result.reason) == (False, "send_failed")
        alert = await _alert(Session, key)
        assert (alert.status, alert.attempt_count, alert.last_error) == ("pending", 1, "RuntimeError")
        assert alert.next_attempt_at > datetime.now(timezone.utc), "실패하면 다음 시도를 뒤로 미룬다"
        assert await _alert_messages(Session, conv_id, key) == [], "실패한 보내기의 메시지는 남지 않는다(SAVEPOINT 롤백)"

        # 아직 때가 아니면 재시도 틱이 건드리지 않는다 → 때를 당기면 보낸다.
        async with Session() as s:
            row = (await s.execute(select(OperatorAlert).where(OperatorAlert.dedupe_key == key))).scalar_one()
            row.next_attempt_at = datetime(2020, 1, 1, tzinfo=timezone.utc)
            await s.commit()
        await process_due_operator_alerts(session_factory=Session)
        alert = await _alert(Session, key)
        assert alert.status == "delivered"
        assert len(await _alert_messages(Session, conv_id, key)) == 1


async def test_retry_tick_stays_within_item_and_time_share(monkeypatch):
    async with _ops_db() as db:
        """PO 조건 1 — 재시도는 한 틱 몫(건수 · 초) 안에서만. 시계는 주입(벽시계 예산 금지)."""
        Session, conv_id = db
        _configure(monkeypatch, None)
        keys = [_key() for _ in range(5)]
        for k in keys:
            await notify_operator(kind="billing.late_charge", dedupe_key=k, session_factory=Session)
        _configure(monkeypatch, conv_id)

        first = await process_due_operator_alerts(max_items=2, session_factory=Session)
        mine = [await _alert(Session, k) for k in keys]
        assert first["attempted"] <= 2
        assert sum(a.status == "delivered" for a in mine) <= 2, "건수 몫을 넘겨 보내지 않는다"

        ticks = iter([0.0, 0.0, 10.0, 10.0, 10.0, 10.0])  # 마감 계산 1 + 첫 건 확인 1 → 둘째 건부터 시간 몫 초과
        second = await process_due_operator_alerts(time_budget_seconds=5.0, clock=lambda: next(ticks), session_factory=Session)
        assert second["stopped_by_budget"] is True
        assert second["attempted"] == 1, "시간 몫이 지나면 새 건을 시작하지 않는다"


async def test_sensitive_values_never_reach_row_or_message(monkeypatch):
    async with _ops_db() as db:
        """PO 조건 2 — 카드 번호 · 결제 키 · 토큰 · 이메일은 이름이든 값이든 거른다(표 · 메시지 둘 다)."""
        Session, conv_id = db
        _configure(monkeypatch, conv_id)
        key = _key()
        card = "4" + "1111111111111111"[1:]  # 16자리 — 이름이 무해해도 값 모양으로 걸러져야 한다
        await notify_operator(
            kind="billing.late_charge", dedupe_key=key, session_factory=Session,
            target={"attempt_id": uuid.UUID(int=9), "customer_email": "a@b.test"},
            facts={"payment_key": "tgen_20260926", "amount_minor": 1000, "reference": card, "note": "free text", "code": "HTTP_409"},
        )
        alert = await _alert(Session, key)
        assert alert.target == {"attempt_id": str(uuid.UUID(int=9))}
        assert alert.facts == {"amount_minor": 1000, "code": "HTTP_409"}
        content = (await _alert_messages(Session, conv_id, key))[0].content
        for leaked in ("tgen_20260926", card, "a@b.test", "free text"):
            assert leaked not in content


def test_sanitize_keeps_ids_amounts_codes_times_only():
    from datetime import datetime, timezone
    from decimal import Decimal

    kept, dropped = sanitize_alert_fields({
        "attempt_id": uuid.UUID(int=1), "amount_minor": 5, "amount": Decimal("12.50"), "code": "LATE", "at": datetime(2026, 9, 26, tzinfo=timezone.utc),
        "billing_key": "x", "access_token": "LATE", "Bad-Name": 1, "memo": "hello",
    })
    assert kept == {
        "attempt_id": str(uuid.UUID(int=1)), "amount_minor": 5, "amount": "12.50", "code": "LATE", "at": "2026-09-26T00:00:00+00:00",
    }
    assert sorted(dropped) == ["Bad-Name", "access_token", "billing_key", "memo"]


@pytest.mark.parametrize("name", ["cardnumber", "apikey", "emailaddress", "secretvalue", "card_no", "customer_email", "access_token"])
def test_sensitive_names_dropped_by_fragment_not_just_whole_part(name):
    """까디르 4713 ② — 밑줄 조각 일치만 보면 `cardnumber` · `apikey`가 빠져나갔다. 값이 무해한 코드여도 이름으로 버린다."""
    kept, dropped = sanitize_alert_fields({name: "OK"})
    assert (kept, dropped) == ({}, [name])


@pytest.mark.parametrize(
    "value",
    ["4111-1111-1111-1111", "4111_1111_1111_1111", "4111.1111.1111.1111", "4111:1111:1111:1111", "4111 1111 1111 1111", "4111111111111111"],
)
def test_card_shaped_values_dropped_whatever_the_separator(value):
    """까디르 4713 ① — 구분자가 끼면 연속 숫자 검사를 빠져나가 «코드»로 실렸다. 구분자를 걷고 센다."""
    kept, dropped = sanitize_alert_fields({"reference": value})
    assert (kept, dropped) == ({}, ["reference"])


def test_uuid_and_iso_time_still_kept_after_separator_stripping():
    """구분자를 걷으면 숫자 줄이 길어지는 모양(uuid · 소수초 ISO 시각)은 모양으로 먼저 받는다 — 걸러 없애지 않는다."""
    values = {"attempt_id": str(uuid.UUID(int=7)), "at": "2026-09-26T08:22:45.123456+00:00", "code": "HTTP_409"}
    assert sanitize_alert_fields(values) == (values, [])


async def test_bad_kind_or_key_is_a_caller_bug():
    with pytest.raises(ValueError):
        await notify_operator(kind="Billing Late", dedupe_key="k")
    with pytest.raises(ValueError):
        await notify_operator(kind="billing.late_charge", dedupe_key="has space")
