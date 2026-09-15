"""story #3903(E-UX-OVERHAUL·§⑤·customer-zero) — 알림함 목록 요약이 raw preset 키를
그대로 노출하는 결함(3888과 같은 클래스, «대화 목록»만 고치고 «알림 목록»은 남음) 처방의
BE 절반. `notifications.event`(JSONB, nullable, additive) 신설 — conversation.mention/
conversation.message 알림 발행 시점에 발신자 이름(제목 렌더시 조합용)과, 그 메시지가
이벤트 발행 메시지면 msg.event(event_key/payload/refs, #2637/#3332/#3884/#3893가 이미
쓰는 그 구조 그대로)를 같이 싣는다 — FE가 렌더 시점에 3888 eventCard 조합 재사용(신규
낱말 0)으로 제목·요약을 짓는다. 옛 행(이 컬럼 도입 前 발행분)은 event가 NULL이라 FE가
기존 body/title 그대로 폴백 — 백필 0.

Revision ID: 0377
Revises: 0376
Create Date: 2026-09-15

PO 확定(2026-09-15 03:11Z) — dispatch_notification()의 ~42개 호출부 中 이 컬럼을 채우는
건 conversation.mention/conversation.message 2곳뿐(호출부 시그니처는 `event: dict | None
= None` 옵셔널 추가라 나머지 40곳 무변경·무회귀). `context` 파라미터(개인 webhook 의미)는
재사용하지 않는다(행에 영속 안 됨·의미가 다름).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0377"
down_revision = "0376"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "notifications",
        sa.Column("event", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("notifications", "event")
