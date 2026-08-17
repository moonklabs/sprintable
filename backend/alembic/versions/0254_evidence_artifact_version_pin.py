"""story #2722(아티팩트·evidence 버전 pin) — evidence.artifact_version_id 신설.

evidence가 아티팩트를 근거로 삼을 때 지금은 `ref`(자유형식 텍스트, `entity:artifact:<uuid>`
또는 claude.ai 링크 등 무엇이든 들어갈 수 있음)뿐이라 "어느 버전을 봤는가"가 원장에 안
남는다 — 아티팩트가 그 뒤 새 버전으로 바뀌면 근거가 조용히 달라져 보인다.

FK는 `artifact_versions.id` 하나만 둔다(`visual_artifact_id`를 evidence에 별도로 두지
않음) — `artifact_versions.artifact_id`가 NOT NULL FK로 이미 `visual_artifacts.id`를
함의하므로, 별도 컬럼은 비정규화(같은 사실을 두 곳에 저장)가 된다. 조회는 evidence→
artifact_versions(1-hop)→visual_artifacts(1-hop)로 충분.

nullable, ON DELETE SET NULL: 이 스토리는 신규 evidence부터 pin을 시작하는 것이 목적이고
소급 백필은 스코프 밖(PO 판정, 2026-08-17) — 기존 행은 전부 NULL(=버전 미상)로 정직하게
남는다. 아티팩트/버전이 나중에 삭제돼도 evidence 행 자체는 살아있어야 하므로 CASCADE가
아니라 SET NULL(근거였다는 사실 자체는 evidence.ref에 여전히 남을 수 있으니 파괴 안 함).

Revision ID: 0254
Revises: 0253
Create Date: 2026-08-17
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0254"
down_revision = "0253"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "evidence",
        sa.Column("artifact_version_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_evidence_artifact_version_id",
        "evidence",
        "artifact_versions",
        ["artifact_version_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_evidence_artifact_version_id",
        "evidence",
        ["artifact_version_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_evidence_artifact_version_id", table_name="evidence")
    op.drop_constraint("fk_evidence_artifact_version_id", "evidence", type_="foreignkey")
    op.drop_column("evidence", "artifact_version_id")
