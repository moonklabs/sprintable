"""Backfill created_by NULLs: agent_personas, docs, doc_revisions

Revision ID: 0010
Revises: 0009
Create Date: 2026-05-04

MV-S3: MV-S1 서베이에서 발견된 created_by NULL 전량 백필.
  - agent_personas.created_by: 40/40 (100%) NULL → 선생님 aac01791 할당
  - docs.created_by: 237/346 (68.5%) NULL → doc_revisions 최초 revision 작성자 역추적, 없으면 선생님
  - doc_revisions.created_by: 3/141 (2.1%) NULL → docs.created_by 역추적, 없으면 선생님
"""
from __future__ import annotations

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

_DEFAULT_USER = "aac01791-5a99-4f5c-99c1-29f35c84cc61"


def upgrade() -> None:
    # 1. agent_personas.created_by — 전량 선생님 할당
    op.execute(f"""
        UPDATE agent_personas
        SET created_by = '{_DEFAULT_USER}'
        WHERE created_by IS NULL
    """)

    # 2a. docs.created_by — doc_revisions 최초 revision 작성자 역추적
    op.execute("""
        UPDATE docs d
        SET created_by = (
            SELECT dr.created_by
            FROM doc_revisions dr
            WHERE dr.doc_id = d.id
              AND dr.created_by IS NOT NULL
            ORDER BY dr.created_at ASC
            LIMIT 1
        )
        WHERE d.created_by IS NULL
    """)

    # 2b. docs.created_by — 역추적 후 남은 NULL → 선생님
    op.execute(f"""
        UPDATE docs
        SET created_by = '{_DEFAULT_USER}'
        WHERE created_by IS NULL
    """)

    # 3a. doc_revisions.created_by — docs.created_by 역추적
    op.execute("""
        UPDATE doc_revisions dr
        SET created_by = (
            SELECT d.created_by
            FROM docs d
            WHERE d.id = dr.doc_id
              AND d.created_by IS NOT NULL
            LIMIT 1
        )
        WHERE dr.created_by IS NULL
    """)

    # 3b. doc_revisions.created_by — 역추적 후 남은 NULL → 선생님
    op.execute(f"""
        UPDATE doc_revisions
        SET created_by = '{_DEFAULT_USER}'
        WHERE created_by IS NULL
    """)


def downgrade() -> None:
    # created_by는 원래 값 복원 불가 (NULL이었다는 정보만 있음) → no-op
    pass
