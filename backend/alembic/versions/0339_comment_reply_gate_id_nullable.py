"""story #3516(Phase2·마케팅운영, 페드루 PO 確定 2026-09-05) — 조각②. 0338이
`channel_post_comment_replies.gate_id`를 NOT NULL로 냈었는데(조각①은 write 0라
안 걸림), 답변 흐름은 draft(에이전트도 작성 가능)→submit(사람, 이 시점에 gate
생성) 2단계라 draft 행 시점엔 gate 자체가 없다 — nullable로 정정. 0338은 이미
develop에 착지했다(#3865 squash 6622aaca8) — 착지 뒤 마이그는 절대 재오픈해
고치지 않는다는 관례 그대로 별개 정정 마이그로 남긴다(원래 작성 시점엔 0338이
아직 리뷰 中이라 "재오픈 방지" 사유였는데, 착지 뒤엔 "이미 실행됐을 수 있는
마이그는 고치지 않는다"는 더 강한 사유로 바뀌었다 — 어느 쪽이든 결론은 같다).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0339"
down_revision = "0338"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "channel_post_comment_replies", "gate_id",
        existing_type=sa.dialects.postgresql.UUID(as_uuid=True), nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "channel_post_comment_replies", "gate_id",
        existing_type=sa.dialects.postgresql.UUID(as_uuid=True), nullable=False,
    )
