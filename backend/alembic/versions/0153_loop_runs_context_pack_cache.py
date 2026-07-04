"""E-LOOP-LEDGER S28(story 116e6fe8) AC④: loop_runs.context_pack_* — synthesis/recommendation 캐싱.

additive·nullable(백필 불요 — 기존 loop은 캐시 미스로 시작, 다음 GET에서 자연 채워짐). gen-LLM
(Claude, 비용 높음) 호출을 "같은 입력=1회만"으로 줄이기 위한 content-hash 캐시 — 회수 items
+loop 맥락+모델/프롬프트 버전이 전부 같을 때만 캐시 hit(app/services/context_pack_items.py 참고).

*_confidence 컬럼(유나 BE↔FE 계약, 2026-07-02): LLM이 산출한 confidence 마커(high/medium/low)를
캐시와 함께 보관 — 캐시 hit 시에도 confidence 배지가 그대로 재현되어야 하므로 텍스트와 동일
생명주기로 저장.
"""
from alembic import op
import sqlalchemy as sa

revision = "0153"
down_revision = "0152"
branch_labels = None
depends_on = None

_COLUMNS = [
    ("context_pack_cache_key", sa.String(length=64)),
    ("context_pack_synthesis", sa.Text()),
    ("context_pack_synthesis_confidence", sa.String(length=16)),
    ("context_pack_recommendation", sa.Text()),
    ("context_pack_recommendation_confidence", sa.String(length=16)),
    ("context_pack_cached_at", sa.DateTime(timezone=True)),
]


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("loop_runs")}
    for name, col_type in _COLUMNS:
        if name not in cols:
            op.add_column("loop_runs", sa.Column(name, col_type, nullable=True))


def downgrade() -> None:
    for name, _ in reversed(_COLUMNS):
        op.drop_column("loop_runs", name)
