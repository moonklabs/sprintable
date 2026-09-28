"""story #4341 AC2 — 결제 쪽 운영자 알림이 운영 알림 서비스로 가고, 시도 응답의 `operator_notified_at`은 **전달된 뒤에만** 선다.

- `_alert("<event>", …)` 호출에 쓰인 이름과 `BILLING_ALERT_EVENTS`가 양쪽으로 같다 — 한쪽에만 있으면 그 사건의 전달이
  `operator_notified_at`에 안 잡히거나(코드에만), 없는 사건을 찾는다(목록에만).
- 실 PG: 결제 알림 한 번 → 운영 대화 메시지 1 · 대상 조직 실림 · True. 전달 전 · 실패 뒤엔 `operator_notified_at` None, 재시도로
  전달되면 그 시각이 따라온다(시도 행에 따로 적지 않아 두 값이 어긋날 자리가 없다).
"""
from __future__ import annotations

import ast
import pathlib
import uuid
from unittest.mock import patch

import pytest

from app.services import billing_payment_attempt as billing
from app.services import operator_alerts
from tests.test_2301_story_body_mentions_realdb import _REAL_DB_URL
from tests.test_4341_operator_alerts_realdb import _alert, _alert_messages, _configure, _ops_db

_SERVICE = pathlib.Path(billing.__file__)


def _alert_call_events() -> set[str]:
    tree = ast.parse(_SERVICE.read_text(encoding="utf-8"))
    events = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_alert":
            first = node.args[0] if node.args else None
            assert isinstance(first, ast.Constant) and isinstance(first.value, str), "_alert의 사건 이름은 글자 그대로 적는다"
            events.add(first.value)
    return events


def test_alert_call_events_and_declared_events_match_both_ways():
    called = _alert_call_events()
    assert len(called) >= 6, "결제 알림 자리 여섯(voided · 늦은 청구 · 환불 실패/미확정 · 결과 모름 · 재조회 종료)을 다 찾아야 가드가 헛돌지 않는다"
    assert called == set(billing.BILLING_ALERT_EVENTS)


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_billing_alert_reaches_ops_conversation_with_org(monkeypatch):
    async with _ops_db() as (Session, conv_id):
        _configure(monkeypatch, conv_id)
        attempt_id, org_id = uuid.uuid4(), uuid.uuid4()
        delivered = await billing.notify_operator(
            "late_charge", attempt_id, "order checkout-x after failed", org_id=org_id,
        )
        assert delivered is True
        key = billing.billing_alert_dedupe_key("late_charge", attempt_id)
        row = await _alert(Session, key)
        assert (row.kind, row.target_org_id, row.facts) == ("billing.late_charge", org_id, {"code": "LATE_CHARGE"})
        msgs = await _alert_messages(Session, conv_id, key)
        assert len(msgs) == 1 and "checkout-x" not in msgs[0].content, "주문 글(detail)은 로그에만 — 대화엔 거른 값만"


@pytest.mark.anyio
@pytest.mark.skipif(not _REAL_DB_URL, reason="통합 테스트는 실 PG(PARITY/ALEMBIC_DATABASE_URL) 필요")
async def test_operator_notified_at_only_after_delivery_and_follows_retry(monkeypatch):
    from datetime import UTC, datetime

    from sqlalchemy import update

    from app.models.operator_alert import OperatorAlert
    from app.routers.org_subscription_checkout import _operator_notified_at

    async with _ops_db() as (Session, conv_id):
        _configure(monkeypatch, conv_id)
        attempt_id, org_id = uuid.uuid4(), uuid.uuid4()
        async with Session() as s:
            assert await _operator_notified_at(s, attempt_id) is None, "알림 전"

        async def boom(*_a, **_k):
            raise RuntimeError("send down")

        with patch.object(operator_alerts, "_send", boom):
            assert await billing.notify_operator("refund_failed", attempt_id, "d", org_id=org_id, facts={"amount_minor": 5000}) is False
        async with Session() as s:
            assert await _operator_notified_at(s, attempt_id) is None, "전달 실패면 비움"
            await s.execute(
                update(OperatorAlert)
                .where(OperatorAlert.dedupe_key == billing.billing_alert_dedupe_key("refund_failed", attempt_id))
                .values(next_attempt_at=datetime(2020, 1, 1, tzinfo=UTC))
            )
            await s.commit()

        await operator_alerts.process_due_operator_alerts(session_factory=Session)
        row = await _alert(Session, billing.billing_alert_dedupe_key("refund_failed", attempt_id))
        assert row.status == "delivered" and row.facts == {"code": "REFUND_FAILED", "amount_minor": 5000}
        async with Session() as s:
            assert await _operator_notified_at(s, attempt_id) == row.delivered_at, "재시도로 전달되면 그 시각이 따라온다"
