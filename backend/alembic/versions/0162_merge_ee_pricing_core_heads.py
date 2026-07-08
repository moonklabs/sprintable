"""story 21ade1fa: alembic 2-head 병합 — ee_pricing(0147)·core(0161)를 단일 head로 수렴.

Revision ID: 0162
Revises: 0161 (main variant — 원 develop 리비전은 ('0147', '0161') 양쪽 병합)
Create Date: 2026-07-07

develop에 0144에서 분기된 두 브랜치(ee_pricing: 0145-0147, core: 0148-0161)가
`alembic upgrade head`(단수)를 실패시킴 — admin repo의 drift-check가 이를 노출.
스키마 변경 없는 순수 병합 노드(양쪽 다 head였던 리비전을 하나로 합침).

migrate-prod-preflight 확認(2026-07-07): main 파일셋엔 0146/0147(ee_pricing, EE/billing 전용)이
story bda4beac(commit 91f7c0bf, PR #1884)에서 영구 제외돼 있다 — 0148도 그때 이미 down_revision을
0147→0145로 reparent해 main 체인이 ee_pricing과 완전히 독립되도록 했다. 이 promotion PR이
develop의 0162(down_revision=('0147','0161'))를 그대로 main에 들여오면 0147을 참조해
KeyError('0147')로 "Main Alembic preflight" CI가 파손된다(로컬 /tmp/main_preflight_sim
재현·검증 완료) — develop 자체의 0162는 원래대로 두고(ee_pricing이 아직 develop 위에선
유효 브랜치), **이 승격 PR에서만** single-parent 변형을 적용한다.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0162'
down_revision: Union[str, Sequence[str], None] = '0161'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
