"""story #3614 갭(Phase2·BE, 페드루 PO 確定 2026-09-11) — channel_post_drafts 재상신
좀비 게이트 결함 처방②. 전체 UniqueConstraint(org_id, work_item_id, connection_id)는
`status`를 모른다 — withdrawn(폐기·종결) 초안이 그 자리를 영구히 점유해, 폐기 뒤
같은 목적지로 재작성하려는 재POST가 "새 초안"을 만들 수 없고(즉시 UniqueViolation)
낡은 withdrawn 초안에 새 버전을 얹는 원래 결함으로 되돌아갈 수밖에 없었다(실측·
create_channel_post_draft_version 매칭 쿼리에 `status != 'withdrawn'`만 추가한
버전으로 직접 재현).

처방 — 전체 제약을 partial unique index로 교체: 같은 (org_id, work_item_id,
connection_id)에 withdrawn 행은 몇 개든 공존하고, **non-withdrawn(활성) 행은
최대 1개**만 허용한다(0041_add_org_invites.py의 status='pending' partial unique와
동형 패턴 — 이 코드베이스의 기존 관례).

Revision ID: 0360
Revises: 0359
Create Date: 2026-09-11
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0360"
down_revision = "0359"
branch_labels = None
depends_on = None

_INDEX_NAME = "uq_channel_post_drafts_org_work_item_connection_active"
_CONSTRAINT_NAME = "uq_channel_post_drafts_org_work_item_connection"


def upgrade() -> None:
    op.drop_constraint(_CONSTRAINT_NAME, "channel_post_drafts", type_="unique")
    op.create_index(
        _INDEX_NAME, "channel_post_drafts", ["org_id", "work_item_id", "connection_id"],
        unique=True, postgresql_where=sa.text("status <> 'withdrawn'"),
    )


def downgrade() -> None:
    # 되돌리기 前에 되돌릴 수 없는 상태(withdrawn 중복으로 전체 제약을 못 세우는 행)가
    # 있는지 먼저 사람이 읽을 수 있는 사유로 명시 실패시킨다 — op.create_unique_
    # constraint가 던지는 raw IntegrityError만으로 두면 "무엇이 왜 막혔는지"가 로그에
    # 안 남는다(이 스토리의 규율 — 조용히 데이터를 건드리거나 원인 불명 실패로 두지
    # 않는다). 실제 제약 생성은 여전히 DB가 원자적으로 검증한다(아래 조회는 사전
    # 진단일 뿐, 유일한 방어선이 아니다).
    conn = op.get_bind()
    dup_rows = conn.execute(sa.text(
        "SELECT org_id, work_item_id, connection_id, count(*) "
        "FROM channel_post_drafts GROUP BY org_id, work_item_id, connection_id HAVING count(*) > 1"
    )).fetchall()
    if dup_rows:
        raise RuntimeError(
            f"downgrade 거부 — {len(dup_rows)}개 (org_id, work_item_id, connection_id) 조합에 "
            "중복 행(withdrawn 포함 다건)이 있어 전체 UniqueConstraint를 되살릴 수 없습니다. "
            "데이터는 손대지 않았습니다 — 그 조합들의 withdrawn 행을 정리한 뒤 다시 시도하세요."
        )
    op.drop_index(_INDEX_NAME, table_name="channel_post_drafts")
    op.create_unique_constraint(
        _CONSTRAINT_NAME, "channel_post_drafts", ["org_id", "work_item_id", "connection_id"],
    )
