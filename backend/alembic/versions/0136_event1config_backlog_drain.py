"""E-EVENT-1CONFIG: webhook-covered agent 의 backlog pending agent-event 1회 drain.

배경(backfill landmine): 기존 ACK 는 acked_seq 만 전진시키고 Event.status 를 안 건드려,
agent SSE 이벤트가 status='pending' 으로 영구 잔존해 왔다. 동반 코드 변경 이후 ACK 는 ACK 한
이벤트를 delivered 마킹하지만, **이미 webhook 으로 전환한 agent**(활성 member-bound webhook
보유)는 더 이상 SSE 로 접속·ACK 하지 않으므로 그들의 기존 pending 이벤트는 영영 retire 되지
않는다 → restart backfill 폭주의 원천. 이 1회 drain 이 그 백로그를 새 ACK 거동과 **동형**으로
delivered 마킹해 cleanup(expire-stale cron) 회수 대상으로 만든다.

스코프(런타임 SSE-skip 판정과 동일 predicate):
  status='pending' AND recipient_type='agent' AND recipient_seq IS NOT NULL(=agent SSE 이벤트)
  AND 수신자가 활성 member-bound webhook 보유(org+member 일치·project 독립).
비-webhook agent 는 SSE 로 정상 ACK 하므로 건드리지 않는다(그들 백로그는 ACK retire + 30일
expire-stale 가 처리).

멱등: status='pending' 행만 전이 → 재실행 시 대상 0(no-op). fresh DB: 매칭 0 → no-op.
fresh-runnable: 순수 UPDATE·스키마 변경 없음.
롤백: 데이터 전이(backlog drain)는 비가역 — no-op downgrade (0099 동일 정책).

Revision ID: 0136
Revises: 0135
Create Date: 2026-06-25
"""
from __future__ import annotations

from alembic import op

revision = "0136"
down_revision = "0135"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE events e
        SET status = 'delivered',
            delivered_at = COALESCE(e.delivered_at, NOW())
        WHERE e.status = 'pending'
          AND e.recipient_type = 'agent'
          AND e.recipient_seq IS NOT NULL
          AND EXISTS (
              SELECT 1
              FROM webhook_configs w
              WHERE w.member_id = e.recipient_id
                AND w.org_id = e.org_id
                AND w.is_active = true
                AND w.member_id IS NOT NULL
          )
        """
    )


def downgrade() -> None:
    # backlog drain(데이터 전이)은 비가역 — no-op (0099·0081 동일 정책).
    pass
