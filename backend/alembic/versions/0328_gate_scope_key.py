"""story #3478(Phase1·마케팅운영·설계갭, 페드루 PO 決定 2026-09-05) — `gate.scope_key`
신설. 그라운딩(디디, 2026-09-05): `create_gate()`의 멱등키는 `(work_item_id,
work_item_type, gate_type[, pr_number[, repo_full_name]])`뿐 — connection/draft
축이 아예 없다. `resolve_gate_holder_draft_id`(story #3404)가 이 사실을
channel_post·site_post 양쪽에 공용으로 미러하는 그 함수라, site_post external_
publish 게이트가 work_item당 1건이라 같은 원문을 WordPress+webhook 두 목적지로
못 보내는 문제는 site_post 국소 결함이 아니라 이 공유 identity 자체의 한계다
(런북 B-3 실측).

페드루 判定 — 공유 UNIQUE의 "의미"를 안 바꾸고 축 하나를 **가산**한다.
`scope_key TEXT NOT NULL DEFAULT ''` — 기존 모든 gate_type(merge·HITL ask·doc
approval 등)은 이 컬럼이 항상 `''`라 그 세 부분 UNIQUE 인덱스에 `scope_key`를
끼워 넣어도 실질적으로 무변(동작 회귀 0, `''` 하나뿐이라 구분력이 그대로 0).
`external_publish` gate_type만 호출부(site_posts.py·channel_posts.py)가
`scope_key = str(draft.connection_id or "")`(목적지)를 채워 실질적으로
draft/destination 단위 게이트가 된다.

세 부분 인덱스 전부(no_pr·pr_repo·pr_no_repo) 재정의 — external_publish는 항상
pr_number가 NULL이라 실제로 유효한 건 no_pr뿐이지만, 세 인덱스의 컬럼 집합을
동일하게 유지해 "어느 것만 scope_key가 있고 어느 것은 없는" 잔여 비대칭을
안 남긴다.

Revision ID: 0328
Revises: 0327
Create Date: 2026-09-05
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0328"
down_revision = "0327"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gate", sa.Column("scope_key", sa.Text(), nullable=False, server_default=""))

    op.drop_index("uq_gate_work_item_gate_type_no_pr", table_name="gate")
    op.create_index(
        "uq_gate_work_item_gate_type_scope_no_pr",
        "gate",
        ["org_id", "work_item_id", "work_item_type", "gate_type", "scope_key"],
        unique=True,
        postgresql_where=sa.text("pr_number IS NULL"),
    )

    op.drop_index("uq_gate_work_item_gate_type_pr_repo", table_name="gate")
    op.create_index(
        "uq_gate_work_item_gate_type_scope_pr_repo",
        "gate",
        ["org_id", "work_item_id", "work_item_type", "gate_type", "scope_key", "pr_number", "repo_full_name"],
        unique=True,
        postgresql_where=sa.text("pr_number IS NOT NULL AND repo_full_name IS NOT NULL"),
    )

    op.drop_index("uq_gate_work_item_gate_type_pr_no_repo", table_name="gate")
    op.create_index(
        "uq_gate_work_item_gate_type_scope_pr_no_repo",
        "gate",
        ["org_id", "work_item_id", "work_item_type", "gate_type", "scope_key", "pr_number"],
        unique=True,
        postgresql_where=sa.text("pr_number IS NOT NULL AND repo_full_name IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_gate_work_item_gate_type_scope_no_pr", table_name="gate")
    op.create_index(
        "uq_gate_work_item_gate_type_no_pr",
        "gate",
        ["org_id", "work_item_id", "work_item_type", "gate_type"],
        unique=True,
        postgresql_where=sa.text("pr_number IS NULL"),
    )

    op.drop_index("uq_gate_work_item_gate_type_scope_pr_repo", table_name="gate")
    op.create_index(
        "uq_gate_work_item_gate_type_pr_repo",
        "gate",
        ["org_id", "work_item_id", "work_item_type", "gate_type", "pr_number", "repo_full_name"],
        unique=True,
        postgresql_where=sa.text("pr_number IS NOT NULL AND repo_full_name IS NOT NULL"),
    )

    op.drop_index("uq_gate_work_item_gate_type_scope_pr_no_repo", table_name="gate")
    op.create_index(
        "uq_gate_work_item_gate_type_pr_no_repo",
        "gate",
        ["org_id", "work_item_id", "work_item_type", "gate_type", "pr_number"],
        unique=True,
        postgresql_where=sa.text("pr_number IS NOT NULL AND repo_full_name IS NULL"),
    )

    op.drop_column("gate", "scope_key")
