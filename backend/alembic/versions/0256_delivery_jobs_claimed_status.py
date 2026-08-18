"""story #2761(P1·prod 실사용 제보) — delivery_jobs 원자적 claim 배선. 근본원인: `_claim_batch()`가
attempts만 올리고 status는 'pending' 그대로 둬(FOR UPDATE SKIP LOCKED는 그 트랜잭션이 열려 있는
"그 순간"만 막음), 배달(외부 I/O)이 poll 주기(2s)를 넘으면 다른 워커 인스턴스가 같은 job을
재집는다 — prod backend minScale=3 독립 인스턴스가 각자 폴링해 "정확히 3번" 중복 발송으로
드러났다(미르코 그라운딩·PO 처방 승인 2026-08-18).

이 마이그는 'claimed' status 값 + claimed_at 타임스탬프 컬럼을 더해, claim 자체를
`UPDATE ... WHERE status='pending' ... RETURNING`(FOR UPDATE SKIP LOCKED 서브쿼리)
하나의 원자적 문으로 만들 수 있게 한다 — status 전이가 attempts 증가와 같은 UPDATE 안에서
일어나 재집기 창이 구조적으로 닫힌다. claimed_at은 크래시 복구(reaper: 만료된 claimed →
pending, at-least-once 보존)의 기준값.

Revision ID: 0256
Revises: 0255
Create Date: 2026-08-18
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0256"
down_revision = "0255"
branch_labels = None
depends_on = None

_OLD_CK = "status IN ('pending', 'delivered', 'failed')"
_NEW_CK = "status IN ('pending', 'claimed', 'delivered', 'failed')"


def upgrade() -> None:
    op.add_column(
        "delivery_jobs",
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.drop_constraint("ck_delivery_jobs_status", "delivery_jobs", type_="check")
    op.create_check_constraint("ck_delivery_jobs_status", "delivery_jobs", _NEW_CK)
    # 워커 폴링 축 부분 인덱스도 claimed 상태 존재를 반영 — reaper가 "claimed 중 만료된 것"을
    # 스캔할 때도 이 인덱스가 커버(WHERE status IN ('pending','claimed')로 확장).
    op.drop_index("ix_delivery_jobs_pending", table_name="delivery_jobs")
    op.create_index(
        "ix_delivery_jobs_pending", "delivery_jobs", ["id"],
        postgresql_where=sa.text("status IN ('pending', 'claimed')"),
    )


def downgrade() -> None:
    op.drop_index("ix_delivery_jobs_pending", table_name="delivery_jobs")
    op.create_index(
        "ix_delivery_jobs_pending", "delivery_jobs", ["id"],
        postgresql_where=sa.text("status = 'pending'"),
    )
    # PO 리뷰(2026-08-18) — 'claimed' row가 존재하는 채로 OLD_CK를 재생성하면 그 즉시 CHECK
    # 위반으로 실패한다(로컬 검증은 빈 테이블이라 놓쳤다). OLD_CK가 'claimed'를 모르므로
    # 먼저 pending으로 정규화 — at-least-once 계약상 claimed는 언젠가 재시도될 값이라
    # pending 복귀가 안전한 유일한 다운그레이드 경로.
    op.execute("UPDATE delivery_jobs SET status = 'pending', claimed_at = NULL WHERE status = 'claimed'")
    op.drop_constraint("ck_delivery_jobs_status", "delivery_jobs", type_="check")
    op.create_check_constraint("ck_delivery_jobs_status", "delivery_jobs", _OLD_CK)
    op.drop_column("delivery_jobs", "claimed_at")
