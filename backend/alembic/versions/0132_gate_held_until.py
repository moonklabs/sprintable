"""E-DG S31: gate.held_until (admin hold 만료·시한부 보류).

S31 hold full UX — admin 이 pending gate 를 일시 보류(held). gate.status='held' + held_until(시한부면
만료 시각·무기한이면 None). FE 가 gate 직독으로 held_until 배지 렌더(step_run.held_until 경유 leaky
회피). additive·nullable·백필 불요(기존 행 NULL=held 아님). default-off 동작영향 0.

⚠️baseline schema.sql 미변경(의도): held_until 은 post-0096 추가(0132)·baseline/REVISION=0096 스냅샷엔
원래 없음(superseded_by(0130)·doc org_id(0131)와 동형). fresh-DB CI(baseline + alembic upgrade head)가
0132 적용. ⭐P0 교훈: 모델(gate.held_until) ↔ 마이그 매칭을 migrated-DB 로 검증(create_all 가림 방지).
"""
from alembic import op
import sqlalchemy as sa

revision = "0132"
down_revision = "0131"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("gate")}
    if "held_until" not in cols:
        op.add_column("gate", sa.Column("held_until", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("gate", "held_until")
