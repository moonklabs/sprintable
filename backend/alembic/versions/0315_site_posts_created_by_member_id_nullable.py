"""story 194acb63(Phase0 결함·S8 후속, 배포 11 실측) —
site_posts.created_by_member_id를 nullable로 정정 + 기존 오기입 백필.

배경: 발행 라우터(#3360·#3369) 둘 다 `created_by_member_id`에 `resolve_member()`가
돌려주는 org_member.id가 아니라 `auth.user_id`(users.id, JWT subject)를 그대로 저장해
왔다 — 상세 화면(S8, story #3386)이 그 값으로 org_members를 조회하지 못해 앞 8자
UUID 폴백으로 샜다(배포 11 실측).

백필 2단계(둘 다 UPDATE ... FROM, 순서 중요):
① `created_by_member_id`가 org_members.id로 이미 유효한 행은 그대로 둔다(WHERE NOT
   EXISTS 가드).
② 남은 행 중 그 값이 실제로는 org_members.user_id(같은 org)와 일치하면 진짜
   org_member.id로 승격.
③ ②를 거치고도 여전히 org_members.id로 유효하지 않은 행(예: 에이전트 team_member.id가
   잘못 들어간 행처럼 사람 계정으로 되짚을 길이 없는 값)은 NULL — 지어내지 않는다
   (AC2 "불가하면 null로 두고 화면 「—」").

Revision ID: 0315
Revises: 0314
Create Date: 2026-09-03
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0315"
down_revision = "0314"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("site_posts", "created_by_member_id", nullable=True)

    # ② user_id 일치분을 org_member.id로 승격(이미 유효한 member_id 행은 매칭 대상에서
    # 자연히 빠진다 — org_members.user_id가 다른 org_members.id와 우연히 같을 수 없다,
    # 둘 다 PK/고유 id 공간이라).
    op.execute(
        sa.text(
            """
            UPDATE site_posts sp
            SET created_by_member_id = om.id
            FROM org_members om
            WHERE om.user_id = sp.created_by_member_id AND om.org_id = sp.org_id
            """
        )
    )
    # ③ 그래도 org_members.id로 유효하지 않으면 null(백필 불가 — 지어내지 않는다).
    op.execute(
        sa.text(
            """
            UPDATE site_posts sp
            SET created_by_member_id = NULL
            WHERE sp.created_by_member_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM org_members om
                  WHERE om.id = sp.created_by_member_id AND om.org_id = sp.org_id
              )
            """
        )
    )


def downgrade() -> None:
    op.alter_column("site_posts", "created_by_member_id", nullable=False)
