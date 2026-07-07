"""story 21ade1fa: alembic 2-head 병합 — ee_pricing(0147)·core(0161)를 단일 head로 수렴.

Revision ID: 0162
Revises: 0147, 0161
Create Date: 2026-07-07

develop에 0144에서 분기된 두 브랜치(ee_pricing: 0145-0147, core: 0148-0161)가
`alembic upgrade head`(단수)를 실패시킴 — admin repo의 drift-check가 이를 노출.
스키마 변경 없는 순수 병합 노드(양쪽 다 head였던 리비전을 하나로 합침).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0162'
down_revision: Union[str, Sequence[str], None] = ('0147', '0161')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
