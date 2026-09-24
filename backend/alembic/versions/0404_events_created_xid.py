"""story #4245(까디르 QA P2 · PO 04:12Z) — events.created_xid: 이벤트를 만든 트랜잭션 id(xid8).

사이드바 «결재» 배지 수(designated-pending-count)를 SSE 연결 직후 백필 이벤트마다 다시 묻지 않으려면, 그 이벤트가 **수를 센 순간 이미 보였는지**를
알아야 한다. 시각(now() = 트랜잭션 시작)으로는 못 가른다 — 게이트 해소 트랜잭션이 이벤트를 t0로 남기고 오래 머문 뒤 커밋하면(외부 호출 대기 등),
그 사이 센 수엔 안 보였는데도 created_at < 조회 시각이 된다. 그래서 커밋 가시성으로 판정한다:
count 응답의 `pg_snapshot_xmin(pg_current_snapshot())`(그 순간 아직 안 끝난 가장 오래된 트랜잭션)보다 created_xid가 작으면, 그 트랜잭션은 수를
센 순간 이미 끝났다(커밋이면 수에 보였고 · 롤백이면 이벤트 자체가 없다).

가산만: 컬럼은 NULL 허용으로 먼저 더하고(옛 행은 NULL — FE는 모르면 다시 묻는다), 기본값은 따로 건다 — ADD COLUMN에 휘발성 기본값을 같이 주면
기존 행마다 평가하느라 테이블을 다시 쓴다. PostgreSQL 13+(dev·prod 15).

번호: 착지 순 사다리(PO) — 미르코 4243이 0403을 쓰는 중이라 0404. 지금 develop 머리는 0402라 down_revision 0402로 두고, 4243(0403)이 먼저
착지하면 rebase 때 down_revision을 0403으로 바꾼다(이 PR이 먼저면 번호를 맞바꾼다).
"""
from __future__ import annotations

from alembic import op

revision = "0404"
down_revision = "0402"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE events ADD COLUMN IF NOT EXISTS created_xid xid8")
    op.execute("ALTER TABLE events ALTER COLUMN created_xid SET DEFAULT pg_current_xact_id()")


def downgrade() -> None:
    op.execute("ALTER TABLE events DROP COLUMN IF EXISTS created_xid")
