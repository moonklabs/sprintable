"""story #3279(지원v1·후속) 핫픽스 — ck_support_messages_role에 'operator' 편입.

⚠️2026-09-01 페드루 PO 라이브 실왕복 실측 발견 — PR#3672(gateway 측 운영자 회신 착지점,
app/routers/operator_replies.py)가 `SupportMessage(role="operator", ...)`를 INSERT하도록
모델·라우터 코드는 넓혔지만, 0001에서 만든 DB CHECK 제약(`role IN ('customer', 'agent',
'system')`)은 그대로 뒀다 — 실 PG에서 'operator' INSERT가 500(check violation)으로 죽는다.
gateway 테스트 스위트는 항상 sqlite 인메모리(tests/conftest.py `_configure_settings`)라
PG 전용 CHECK 제약 위반을 구조적으로 못 잡는다(sqlite는 이 제약 자체를 안 검사) — 이번
실사고의 근인 층. 재발 방지(별도 systemic 등재)는 PO 담당, 이 마이그레이션은 그 증상의
직접 원인만 닫는다.

Postgres는 CHECK 제약을 직접 ALTER 못 한다 — drop 후 새 정의로 재생성.

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-01
"""
from __future__ import annotations

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_support_messages_role", "support_messages", type_="check")
    op.create_check_constraint(
        "ck_support_messages_role", "support_messages", "role IN ('customer', 'agent', 'system', 'operator')"
    )


def downgrade() -> None:
    op.drop_constraint("ck_support_messages_role", "support_messages", type_="check")
    op.create_check_constraint(
        "ck_support_messages_role", "support_messages", "role IN ('customer', 'agent', 'system')"
    )
