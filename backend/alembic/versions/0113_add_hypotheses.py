"""E1 L3: hypotheses 1급 엔티티 + epic/story 링크 테이블.

Revision ID: 0113
Revises: 0112
Create Date: 2026-06-11

블루프린트 `blueprint-e1-hypothesis-entity` §2·§8. 가설을 outcome 컬럼에서 1급
엔티티로 승격(기존 outcome 컬럼 삭제 없음). epic/story는 링크 테이블로 무접촉 연결.

idempotent: 테이블 단위 inspect 가드(0067 gate 선례). 자동 backfill 없음(§8.2 —
owner_member_id NOT NULL 해소 불가, 별도 운영 command로 수동 이관). downgrade는
링크 테이블을 먼저 drop 후 hypotheses drop.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0113"
down_revision = "0112"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = set(insp.get_table_names())

    # step0: epics.id PRIMARY KEY 드리프트 교정 (0107 docs_pkey 선례와 동일 클래스).
    # baseline 스냅샷(dev 0096)에 epics_pkey가 소실 — projects/stories엔 PK 있는데 epics만 부재.
    # hypothesis_epic_links.epic_id FK가 referenced 유일성을 요구하므로 선행 필수. PK 부재 시만
    # 추가(idempotent). downgrade에서 되돌리지 않는다(되돌리면 결함 재현).
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.epics'::regclass AND contype = 'p'
            ) THEN
                ALTER TABLE public.epics ADD CONSTRAINT epics_pkey PRIMARY KEY (id);
            END IF;
        END $$;
        """
    )

    if "hypotheses" not in existing:
        op.create_table(
            "hypotheses",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column(
                "project_id",
                UUID(as_uuid=True),
                sa.ForeignKey("projects.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("owner_member_id", UUID(as_uuid=True), nullable=False),
            sa.Column("created_by_member_id", UUID(as_uuid=True), nullable=True),
            sa.Column("confirmed_by_member_id", UUID(as_uuid=True), nullable=True),
            sa.Column("statement", sa.Text(), nullable=False),
            sa.Column("metric_definition", JSONB, nullable=False),
            sa.Column("measure_after", sa.DateTime(timezone=True), nullable=False),
            sa.Column("status", sa.String(24), nullable=False, server_default="proposed"),
            sa.Column("outcome_result", JSONB, nullable=True),
            sa.Column("confidence", sa.Numeric(5, 4), nullable=True),
            sa.Column("source_type", sa.String(32), nullable=True),
            sa.Column("source_id", UUID(as_uuid=True), nullable=True),
            sa.Column("source_snapshot", JSONB, nullable=True),
            sa.Column("drafted_by_member_id", UUID(as_uuid=True), nullable=True),
            sa.Column("draft_metadata", JSONB, nullable=True),
            sa.Column(
                "human_accounting",
                JSONB,
                nullable=False,
                server_default=sa.text("'{}'::jsonb"),
            ),
            sa.Column(
                "gate_contract",
                JSONB,
                nullable=False,
                server_default=sa.text("'{}'::jsonb"),
            ),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
            sa.CheckConstraint(
                "status IN ('proposed','active','measuring','verified','falsified','killed','archived')",
                name="ck_hypotheses_status",
            ),
            sa.CheckConstraint(
                "jsonb_typeof(metric_definition) = 'object'",
                name="ck_hypotheses_metric_object",
            ),
        )
        # OrgScopedMixin tenant 필터용 단일 org_id 인덱스 + §2.4 인덱스 5종
        op.create_index("ix_hypotheses_org_id", "hypotheses", ["org_id"])
        op.create_index(
            "ix_hypotheses_org_project_status_created_at",
            "hypotheses",
            ["org_id", "project_id", "status", sa.text("created_at DESC")],
        )
        op.create_index(
            "ix_hypotheses_owner",
            "hypotheses",
            ["org_id", "owner_member_id", sa.text("created_at DESC")],
        )
        op.create_index(
            "ix_hypotheses_measure_due",
            "hypotheses",
            ["org_id", "status", "measure_after"],
            postgresql_where=sa.text("status IN ('active','measuring')"),
        )
        op.create_index(
            "ix_hypotheses_metric_gin",
            "hypotheses",
            ["metric_definition"],
            postgresql_using="gin",
        )
        op.create_index(
            "ix_hypotheses_source",
            "hypotheses",
            ["org_id", "source_type", "source_id"],
        )

    if "hypothesis_epic_links" not in existing:
        op.create_table(
            "hypothesis_epic_links",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "hypothesis_id",
                UUID(as_uuid=True),
                sa.ForeignKey("hypotheses.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "epic_id",
                UUID(as_uuid=True),
                sa.ForeignKey("epics.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("link_type", sa.String(24), nullable=False, server_default="primary"),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.UniqueConstraint("hypothesis_id", "epic_id", name="uq_hypothesis_epic_links"),
        )
        op.create_index(
            "ix_hypothesis_epic_links_epic",
            "hypothesis_epic_links",
            ["epic_id", "link_type"],
        )

    if "hypothesis_story_links" not in existing:
        op.create_table(
            "hypothesis_story_links",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "hypothesis_id",
                UUID(as_uuid=True),
                sa.ForeignKey("hypotheses.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "story_id",
                UUID(as_uuid=True),
                sa.ForeignKey("stories.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("link_type", sa.String(24), nullable=False, server_default="supports"),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.UniqueConstraint("hypothesis_id", "story_id", name="uq_hypothesis_story_links"),
        )
        op.create_index(
            "ix_hypothesis_story_links_story",
            "hypothesis_story_links",
            ["story_id"],
        )


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = set(insp.get_table_names())

    # 링크 테이블 먼저 — hypotheses FK 의존이라 역순 drop. drop_table이 인덱스/제약 동반 제거.
    if "hypothesis_story_links" in existing:
        op.drop_table("hypothesis_story_links")
    if "hypothesis_epic_links" in existing:
        op.drop_table("hypothesis_epic_links")
    if "hypotheses" in existing:
        op.drop_table("hypotheses")
