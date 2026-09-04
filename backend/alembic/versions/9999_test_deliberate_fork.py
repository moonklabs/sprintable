"""THROWAWAY — story 3436 묶음 7 RED->GREEN proof only, reverted before merge.
Deliberately forks off 0321 (same parent as 0322) to create a second head,
simulating the #3802-class incident (lost base-branch commit -> orphaned
migration chain).

Revision ID: 9999test
Revises: 0321
Create Date: 2026-09-05
"""
from __future__ import annotations

revision = "9999test"
down_revision = "0321"
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
