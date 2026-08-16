"""QA test fixture B for story #2401 sibling-collision guard (Mirko cross-QA, throwaway).
Different revision value from A but SAME down_revision — axis B (dual-head) positive control.

Revision ID: 0997
Revises: 0252
Create Date: 2026-08-16
"""
from __future__ import annotations

revision = "0996"
down_revision = "0999"
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
