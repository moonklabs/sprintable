"""E-STORAGE-SSOT S2: asset registry — assets / asset_folders / asset_links.

Revision ID: 0139
Revises: 0138
Create Date: 2026-06-26

S1 IStorageService 위에 빌드. 모든 업로드를 queryable한 asset row로 편입. asset_links =
참조원(message/story/doc/manual) SSOT(catch#4).

idempotent: 테이블 단위 inspect 가드(0113 선례). 기존 chat/story 첨부(JSONB) → asset/asset_link
**멱등 백필**(ON CONFLICT DO NOTHING·keyset 배치). 외부 URL/타 버킷은 우리 객체 아니므로 스킵.
downgrade는 links → assets → asset_folders 역순 drop.
"""
from __future__ import annotations

import os

import sqlalchemy as sa
from alembic import op
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import UUID

revision = "0139"
down_revision = "0138"
branch_labels = None
depends_on = None

_BACKFILL_BATCH = 500
# S1 GCS_MEMO_ATTACHMENTS_BUCKET 기본과 정합. legacy 첨부 컨테이너.
_BUCKET = os.environ.get("GCS_MEMO_ATTACHMENTS_BUCKET", "sprintable-memo-attachments")
_PREFIX = f"https://storage.googleapis.com/{_BUCKET}/"

# legacy url → canonical object_path: GCS public prefix 제거 / bare 그대로 / 외부 스킴 스킵(NULL).
_CANON = (
    "CASE WHEN att->>'url' LIKE :prefix || '%' "
    "THEN substr(att->>'url', length(:prefix) + 1) ELSE att->>'url' END"
)
# 우리 객체만(GCS prefix 또는 bare). 외부 https/gs/file 등은 제외.
_OURS = "(att->>'url' LIKE :prefix || '%' OR position('://' in att->>'url') = 0)"


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    existing = set(insp.get_table_names())

    if "asset_folders" not in existing:
        op.create_table(
            "asset_folders",
            sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("project_id", UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=True),
            sa.Column("parent_id", UUID(as_uuid=True), sa.ForeignKey("asset_folders.id", ondelete="CASCADE"), nullable=True),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("created_by", UUID(as_uuid=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint("org_id", "project_id", "parent_id", "name", name="uq_asset_folders_parent_name"),
        )
        op.create_index("ix_asset_folders_org_id", "asset_folders", ["org_id"])
        op.create_index("ix_asset_folders_project_id", "asset_folders", ["project_id"])
        op.create_index("ix_asset_folders_parent_id", "asset_folders", ["parent_id"])
        op.create_index("ix_asset_folders_project_parent", "asset_folders", ["org_id", "project_id", "parent_id"])

    if "assets" not in existing:
        op.create_table(
            "assets",
            sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("project_id", UUID(as_uuid=True), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=True),
            sa.Column("folder_id", UUID(as_uuid=True), sa.ForeignKey("asset_folders.id", ondelete="SET NULL"), nullable=True),
            sa.Column("container", sa.Text(), nullable=False),
            sa.Column("object_path", sa.Text(), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("content_type", sa.Text(), nullable=True),
            sa.Column("size_bytes", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("created_by", UUID(as_uuid=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint("container", "object_path", name="uq_assets_container_object_path"),
        )
        op.create_index("ix_assets_org_id", "assets", ["org_id"])
        op.create_index("ix_assets_project_id", "assets", ["project_id"])
        op.create_index("ix_assets_folder_id", "assets", ["folder_id"])
        op.create_index(
            "ix_assets_org_project_ctype_created",
            "assets",
            ["org_id", "project_id", "content_type", sa.text("created_at DESC")],
        )

    if "asset_links" not in existing:
        op.create_table(
            "asset_links",
            sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
            sa.Column("org_id", UUID(as_uuid=True), nullable=False),
            sa.Column("asset_id", UUID(as_uuid=True), sa.ForeignKey("assets.id", ondelete="CASCADE"), nullable=False),
            sa.Column("source_type", sa.Text(), nullable=False),
            sa.Column("source_id", UUID(as_uuid=True), nullable=True),
            sa.Column("created_by", UUID(as_uuid=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.UniqueConstraint("asset_id", "source_type", "source_id", name="uq_asset_links_asset_source"),
            sa.CheckConstraint(
                "source_type IN ('conversation_message','story','doc','manual')",
                name="ck_asset_links_source_type",
            ),
        )
        op.create_index("ix_asset_links_org_id", "asset_links", ["org_id"])
        op.create_index("ix_asset_links_asset_id", "asset_links", ["asset_id"])
        op.create_index("ix_asset_links_source", "asset_links", ["source_type", "source_id"])

    _backfill(conn)


def _backfill(conn) -> None:
    """기존 chat/story 첨부(JSONB) → asset/asset_link 멱등 편입. keyset 배치(prod 락/시간 안전)."""
    _backfill_source(
        conn,
        table="conversation_messages",
        join="JOIN conversations c ON c.id = m.conversation_id",
        org_expr="c.org_id",
        project_expr="c.project_id",
        source_type="conversation_message",
    )
    _backfill_source(
        conn,
        table="stories",
        join="",
        org_expr="m.org_id",
        project_expr="m.project_id",
        source_type="story",
    )


def _backfill_source(conn, *, table, join, org_expr, project_expr, source_type) -> None:
    params = {"prefix": _PREFIX, "bucket": _BUCKET}

    ids_sql = text(
        f"SELECT m.id FROM {table} m "
        f"WHERE m.id > :last AND m.attachments IS NOT NULL "
        f"AND jsonb_array_length(m.attachments) > 0 ORDER BY m.id LIMIT :lim"
    )
    insert_assets = text(
        f"""
        INSERT INTO assets (org_id, project_id, container, object_path, name, content_type, size_bytes)
        SELECT {org_expr}, {project_expr}, :bucket, {_CANON},
               COALESCE(NULLIF(att->>'name', ''), 'file'),
               NULLIF(att->>'content_type', ''),
               COALESCE((att->>'size')::bigint, 0)
        FROM {table} m {join}
        CROSS JOIN LATERAL jsonb_array_elements(m.attachments) AS att
        WHERE m.id IN :ids AND att->>'url' IS NOT NULL AND {_OURS}
        ON CONFLICT (container, object_path) DO NOTHING
        """
    ).bindparams(bindparam("ids", expanding=True))
    insert_links = text(
        f"""
        INSERT INTO asset_links (org_id, asset_id, source_type, source_id)
        SELECT {org_expr}, a.id, :source_type, m.id
        FROM {table} m {join}
        CROSS JOIN LATERAL jsonb_array_elements(m.attachments) AS att
        JOIN assets a ON a.container = :bucket AND a.object_path = {_CANON}
        WHERE m.id IN :ids AND att->>'url' IS NOT NULL AND {_OURS}
        ON CONFLICT (asset_id, source_type, source_id) DO NOTHING
        """
    ).bindparams(bindparam("ids", expanding=True))

    last = "00000000-0000-0000-0000-000000000000"
    while True:
        rows = conn.execute(ids_sql, {"last": last, "lim": _BACKFILL_BATCH}).fetchall()
        if not rows:
            break
        ids = [r[0] for r in rows]
        conn.execute(insert_assets, {**params, "ids": ids})
        conn.execute(insert_links, {**params, "ids": ids, "source_type": source_type})
        last = str(ids[-1])


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS asset_links")
    op.execute("DROP TABLE IF EXISTS assets")
    op.execute("DROP TABLE IF EXISTS asset_folders")
