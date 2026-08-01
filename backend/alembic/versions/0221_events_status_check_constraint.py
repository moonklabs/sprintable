"""story #2391(2026-08-01) — events.status에 CHECK 제약을 붙인다(구조로 막기, AC2).

배경: `events.status`는 여태 순수 Text 컬럼이라 오타·미선언 값이 조용히 통과했다.
`EventStatus`(app/models/event.py) enum이 pending/delivered/failed 셋만 선언했는데, 실제로는
`expired`(30일 초과 pending을 회수하는 expire_stale_events_core, app/routers/events.py)가
8개월 가까이 이 enum 밖에서 살아 있었다 — enum에 없고 DB CHECK도 없어 아무도 안 걸렸다.

dev DB `status` DISTINCT 실측(전량, 2026-08-01 12:4xZ, PO):
  delivered 4,151 · pending 86 · expired 80 · failed 0
⛔이 넷은 dev 기준이다. prod는 이 마이그레이션 작성 시점에 측정하지 못했다 — prod에 이 넷
밖의 값이 있으면 이 마이그레이션이 prod에 적용될 때(NOT VALID 없는 일반 CHECK ADD는 기존
행을 즉시 검증한다) 실패로 멈춘다. 그 실패는 안전한 방향이다(데이터 훼손이 아니라 배포
정지) — 그래도 적용 전에 prod에서 `SELECT DISTINCT status FROM events`로 한 번 더 확認하는
것을 권장한다(PO/디디군 lane).

`failed`는 코드·dev DB 둘 다 0건이지만 CHECK에는 포함한다(app/models/event.py의 EventStatus
docstring 참조 — "지금 0건"과 "원리적으로 안 난다"는 다른 주장이라는 PO 판단).

순수 additive — 신규 CHECK 제약 하나, 기존 컬럼/데이터 변경 0. 넷 다(pending/delivered/
expired/failed) 허용하므로 기존 행 4,317개(dev 기준) 전부 통과.

Revision ID: 0221
Revises: 0220
Create Date: 2026-08-01
"""
from alembic import op

revision = "0221"
down_revision = "0220"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_check_constraint(
        "ck_events_status",
        "events",
        "status IN ('pending', 'delivered', 'expired', 'failed')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_events_status", "events", type_="check")
