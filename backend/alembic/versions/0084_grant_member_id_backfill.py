"""E-MEMBER-SSOT AC3-2c: grant write-sync — 휴먼 members 재조정 + project_access.member_id 백필.

create_project_access가 anchor 후에도 project_access.member_id를 NULL로 두어(org_member_id만 세팅),
신규 grant-only 휴먼이 member_id 없이 남는다 → AC3-3 get_missing 등 member_id 가정 코드가 누락(이미
org_member_id로 우회했으나, AC3-4 projection은 member_id 읽기 토대 필요). 코드는 ensure_human_member로
신규 grant부터 세팅하고, 이 마이그는 **기존 데이터** 보정.

전제: 신규 휴먼(0075 이후)은 members 행이 없을 수 있다(휴먼 write-sync 부재) → member_id=org_member_id를
넣으려면 members 행 선행 필요(fk_project_access_member). 따라서:
1. 휴먼 members 재조정(0075 §3 human 백필 idempotent 재실행) — post-0075 휴먼 포착.
2. project_access.member_id = org_member_id 백필(member_id NULL·org_member_id 有·members 실재 시만, orphan-safe 트랩#4).

추가형·가역(downgrade no-op, 0075/0082 정책). FK VALIDATE는 별도(다른 phase — agent placement 등 surface 큼).

Revision ID: 0084
Revises: 0083
Create Date: 2026-06-04
"""
from __future__ import annotations

from alembic import op

revision = "0084"
down_revision = "0083"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. 휴먼 members 재조정 — 0075 §3 human 백필 동형(idempotent). post-0075 신규 휴먼 포착.
    #    members.id = org_member.id, name=users.display_name/email(orphan user→user_id NULL), orphan org 스킵.
    op.execute(
        """
        INSERT INTO members (id, org_id, type, user_id, owner_member_id, name, org_role, is_active, created_at, updated_at)
        SELECT om.id, om.org_id, 'human', u.id, NULL,
               COALESCE(u.display_name, u.email, om.user_id::text),
               om.role, true, om.created_at, now()
        FROM org_members om
        JOIN organizations o ON o.id = om.org_id
        LEFT JOIN users u ON u.id = om.user_id
        WHERE om.deleted_at IS NULL
        ON CONFLICT (id) DO NOTHING
        """
    )
    # 2. project_access.member_id = org_member_id 백필(휴먼 grant). members 실재 시만(orphan-safe).
    op.execute(
        """
        UPDATE project_access SET member_id = org_member_id
        WHERE member_id IS NULL AND org_member_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM members m WHERE m.id = project_access.org_member_id)
        """
    )


def downgrade() -> None:
    # 데이터 백필(휴먼 members + project_access.member_id) — 역삭제는 정상분과 구분 불가. no-op(0075 정책).
    pass
