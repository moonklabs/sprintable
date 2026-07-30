"""story #2223(E-CONNECT) 판정(오르테가군, 2026-07-30) — reference_semantic_candidates.
relation_kind CHECK에 'superseded'(대체) 추가. 다른 5종과 성질이 다른 유일한 값(한쪽이
죽는 관계) — 자동분류 규칙에는 안 넣는다, 사람이 직접 골라야만 붙는다
(app/models/reference_semantic_candidate.py 참조).

순수 additive — CHECK 재정의뿐, 기존 행 손상 0(기존 값 전부 새 CHECK를 그대로 통과).

Revision ID: 0219
Revises: 0218
Create Date: 2026-07-30
"""
from alembic import op

revision = "0219"
down_revision = "0218"
branch_labels = None
depends_on = None

OLD_CHECK = (
    "relation_kind IS NULL OR relation_kind IN "
    "('spawned', 'cited_as_evidence', 'similar_case', 'followed', 'explicitly_unrelated')"
)
NEW_CHECK = (
    "relation_kind IS NULL OR relation_kind IN "
    "('spawned', 'cited_as_evidence', 'similar_case', 'followed', "
    "'explicitly_unrelated', 'superseded')"
)


def upgrade() -> None:
    op.drop_constraint(
        "ck_reference_semantic_candidates_relation_kind",
        "reference_semantic_candidates",
        type_="check",
    )
    op.create_check_constraint(
        "ck_reference_semantic_candidates_relation_kind",
        "reference_semantic_candidates",
        NEW_CHECK,
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_reference_semantic_candidates_relation_kind",
        "reference_semantic_candidates",
        type_="check",
    )
    op.create_check_constraint(
        "ck_reference_semantic_candidates_relation_kind",
        "reference_semantic_candidates",
        OLD_CHECK,
    )
