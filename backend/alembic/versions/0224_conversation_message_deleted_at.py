"""story #2319 — 채팅 메시지 「삭제」 tombstone 컬럼.

PO 결정(2026-07-29 04:41Z, 스토리 본문): tombstone. hard delete 아님.
  ①대화는 여럿이 읽는 자리 — 행을 통째로 지우면 답글·맥락이 같이 끊긴다.
  ②#2259 규율 — 지워진 대상은 「끊어졌다」로 남는다(사라지지 않는다).
  ③오·발송(비밀번호 등) 스크럽 용도도 tombstone으로 충족(내용을 실제로 지우므로).

컬럼은 새로 발명하지 않고 기존 SoftDeleteMixin(Doc·Story가 이미 쓰는 그 `deleted_at`,
backend/app/models/base.py)을 그대로 재사용한다 — 이름·타입 동일. 단 **읽기 관례는
Doc/Story와 다르다**: Doc/Story는 `.deleted_at.is_(None)`으로 목록에서 통째로 걸러내지만,
메시지는 걸러내지 않는다(행이 그대로 스레드에 남아 tombstone으로 보인다) — 모델 docstring
참조. DELETE 핸들러가 content를 실제로 덮어써 지운다(플래그만 세우면 ③ 스크럽 목적이 안 선다).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0224"
down_revision = "0223"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversation_messages",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("conversation_messages", "deleted_at")
