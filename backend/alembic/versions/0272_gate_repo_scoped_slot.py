"""story #2932([게이트·후속] PR단위 슬롯 하드닝 3건, HIGH1) — gate 슬롯 identity에 repo 편입.

0271(A1)이 멱등 키를 `(work_item_id, gate_type)` → `(work_item_id, gate_type, pr_number)`로
확장해 PR간 격리를 구조로 보장했지만, `pr_number`는 repo 경계 없이 전역(스토리 스코프
안에서)으로만 유니크했다 — 같은 스토리에 **다른 repo의 동일 번호 PR**이 링크되면(예:
cross-repo 재구성·모노레포 분리 등) 두 PR이 같은 게이트 슬롯을 공유해 SHA/evidence가
섞인다(story #2932 HIGH1, 카디르 소스 직접확認).

백필: 0271과 동일 패턴 — `neutral_facts.repo`(evaluate_merge_gate가 매 호출마다 이미
적어 옴, merge_verdict_gate.py facts dict)에서 그대로 끌어온다. GitHub API 역조회 불요.

제약 재설계: pr_number IS NOT NULL 구간을 다시 둘로 쪼갠다 — repo_full_name도 아는
행(정밀 스코프: pr_number+repo 둘 다로 유니크)과 모르는 행(레거시/미백필, pr_number만으로
유니크 — 0271 그대로 유지, cross-repo disambiguation을 못 하지만 그 이상 나빠지지도
않는다). NULL-pr_number 구간(0271의 no_pr 인덱스)은 이 마이그의 스코프 밖 — 그대로 둔다.

Revision ID: 0272
Revises: 0271
Create Date: 2026-08-22
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0272"
down_revision = "0271"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("gate", sa.Column("repo_full_name", sa.Text(), nullable=True))

    op.execute(
        """
        UPDATE gate
        SET repo_full_name = (neutral_facts->>'repo')
        WHERE gate_type = 'merge'
          AND neutral_facts ? 'repo'
          AND (neutral_facts->>'repo') <> ''
        """
    )

    op.drop_index("uq_gate_work_item_gate_type_pr", table_name="gate")
    op.create_index(
        "uq_gate_work_item_gate_type_pr_repo",
        "gate",
        ["org_id", "work_item_id", "work_item_type", "gate_type", "pr_number", "repo_full_name"],
        unique=True,
        postgresql_where=sa.text("pr_number IS NOT NULL AND repo_full_name IS NOT NULL"),
    )
    op.create_index(
        "uq_gate_work_item_gate_type_pr_no_repo",
        "gate",
        ["org_id", "work_item_id", "work_item_type", "gate_type", "pr_number"],
        unique=True,
        postgresql_where=sa.text("pr_number IS NOT NULL AND repo_full_name IS NULL"),
    )


def downgrade() -> None:
    # 0271 downgrade와 동일 lossy 원칙(PO 선례) — pr_number 스코프 안에서 repo_full_name이
    # 다른 행이 2개 이상(=이 마이그 목적 자체가 만드는 정상 상태, cross-repo 격리) 실존하면
    # 옛 pr_number-only 유니크 복원이 UniqueViolation으로 막힌다. repo_full_name을 아는
    # 행을 모르는 행보다 우선 보존(있는 정보가 없는 정보보다 낫다), 동순위는 id DESC로
    # 결정론적 타이브레이크.
    op.execute(
        """
        DELETE FROM gate
        WHERE id IN (
            SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY org_id, work_item_id, work_item_type, gate_type, pr_number
                           ORDER BY (repo_full_name IS NOT NULL) DESC, id DESC
                       ) AS rn
                FROM gate
                WHERE pr_number IS NOT NULL
            ) ranked
            WHERE rn > 1
        )
        """
    )
    op.drop_index("uq_gate_work_item_gate_type_pr_no_repo", table_name="gate")
    op.drop_index("uq_gate_work_item_gate_type_pr_repo", table_name="gate")
    op.create_index(
        "uq_gate_work_item_gate_type_pr",
        "gate",
        ["org_id", "work_item_id", "work_item_type", "gate_type", "pr_number"],
        unique=True,
        postgresql_where=sa.text("pr_number IS NOT NULL"),
    )
    op.drop_column("gate", "repo_full_name")
