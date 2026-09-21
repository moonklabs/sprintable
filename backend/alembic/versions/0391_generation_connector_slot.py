"""story #4101([E-RECIPE-1] 연산(Compute) 슬롯 1/2, #4095 그라운딩 doc c65ce586 §3-1
후보A·§3-4·PO Q②병렬 確定, 2026-09-21) — 리허설 1호 지름길②("제품 연산 슬롯이 비어
있어 댄이 자기 Vertex 스크립트로 대체") 근본 처방.

1. `org_generation_connectors` 신설(#3373 `channel_connections`와 병렬 — 발행 목적지가
   아니라 org가 소유한 생성 모델 provider 자격 원장). credentials는 암호화 컬럼(응답에
   절대 미노출, write-only).
2. `recipe_role_bindings.generation_connector_id` 추가 — #4090(0387)이 연 2-값 XOR
   (agent_member_id|channel_connection_id)을 3-값으로 확장(num_nonnulls=1, 세 값
   나열보다 확장에 안전 — 같은 CHECK 이름 재사용, 새 이름 발명 0).
3. `video_production` 프리셋의 `live_generation` stage에 `capability.target=
   "generation_connector"` 부여(0389와 동형 jsonb_set + WHERE 실값 일치 idempotent
   패턴 — stage_metadata 전체가 아니라 이 stage 키만 patch).

FK는 의도적으로 안 건다 — agent_member_id/channel_connection_id도 FK가 없는 이
테이블 기존 관례(team_members가 VIEW라 FK 불가능한 선례) 그대로 유지.

Revision ID: 0391
Revises: 0390
Create Date: 2026-09-21
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0391"
down_revision = "0390"
branch_labels = None
depends_on = None

_CHECK_NAME = "ck_recipe_role_bindings_exactly_one_target"
_OLD_CHECK_SQL = (
    "(agent_member_id IS NOT NULL AND channel_connection_id IS NULL) "
    "OR (agent_member_id IS NULL AND channel_connection_id IS NOT NULL)"
)
_NEW_CHECK_SQL = "num_nonnulls(agent_member_id, channel_connection_id, generation_connector_id) = 1"

_KEY = "preset.marketing.video_production"
_STAGE_KEY = "live_generation"
_OLD_LIVE_GENERATION = {
    "role": "Compute", "action": "실탄(유료 생성) 모델(키컷·i2v·음성·립싱크) 호출",
    "capability": {"kind": "generate"},
}
_NEW_LIVE_GENERATION = {
    "role": "Compute", "action": "실탄(유료 생성) 모델(키컷·i2v·음성·립싱크) 호출",
    "capability": {"kind": "generate", "target": "generation_connector"},
}


def _patch_stage(bind, *, old_stage: dict, new_stage: dict, version_delta: int) -> None:
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET stage_metadata = jsonb_set(stage_metadata, CAST(:path AS text[]), CAST(:new_stage AS jsonb)), "
            " version = version + :delta "
            "WHERE org_id IS NULL AND key = :key AND stage_metadata -> :stage_key = CAST(:old_stage AS jsonb)"
        ),
        {
            "path": "{" + _STAGE_KEY + "}", "new_stage": json.dumps(new_stage),
            "delta": version_delta, "key": _KEY, "stage_key": _STAGE_KEY, "old_stage": json.dumps(old_stage),
        },
    )


def upgrade() -> None:
    op.create_table(
        "org_generation_connectors",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", UUID(as_uuid=True), nullable=False),
        sa.Column("provider_key", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("model_config_json", JSONB(), nullable=False, server_default="{}"),
        sa.Column("encrypted_credentials", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("created_by", UUID(as_uuid=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("org_id", "label", name="uq_org_generation_connectors_org_label"),
        sa.CheckConstraint("status IN ('active', 'revoked')", name="ck_org_generation_connectors_status"),
    )
    op.create_index("ix_org_generation_connectors_org_id", "org_generation_connectors", ["org_id"])

    op.add_column(
        "recipe_role_bindings", sa.Column("generation_connector_id", UUID(as_uuid=True), nullable=True),
    )
    op.drop_constraint(_CHECK_NAME, "recipe_role_bindings", type_="check")
    op.create_check_constraint(_CHECK_NAME, "recipe_role_bindings", _NEW_CHECK_SQL)

    bind = op.get_bind()
    _patch_stage(bind, old_stage=_OLD_LIVE_GENERATION, new_stage=_NEW_LIVE_GENERATION, version_delta=1)


def downgrade() -> None:
    bind = op.get_bind()
    _patch_stage(bind, old_stage=_NEW_LIVE_GENERATION, new_stage=_OLD_LIVE_GENERATION, version_delta=-1)

    op.drop_constraint(_CHECK_NAME, "recipe_role_bindings", type_="check")
    op.execute("DELETE FROM recipe_role_bindings WHERE generation_connector_id IS NOT NULL")
    op.create_check_constraint(_CHECK_NAME, "recipe_role_bindings", _OLD_CHECK_SQL)
    op.drop_column("recipe_role_bindings", "generation_connector_id")

    op.drop_index("ix_org_generation_connectors_org_id", table_name="org_generation_connectors")
    op.drop_table("org_generation_connectors")
