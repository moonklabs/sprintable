"""P0 hotfix: doc_revisions/doc_comments 에 org_id·project_id 추가(model↔DB drift 봉합).

🔴 P0: GET /docs/{id}/revisions·/comments 가 dev 에서 500. DocRevision/DocComment **모델은
OrgScopedMixin+project_id(둘 다 NN)** 인데 dev 테이블(baseline 0096)엔 두 컬럼이 없어 `select(모델)` 이
없는 컬럼을 참조 → SQL 에러. (model 에 컬럼이 추가됐으나 마이그가 없던 latent drift — revision 미배선
이라 FE 가 안 불러 잠복하다 S28 revision 배선+타임라인 fetch 로 활성화.)

fix: 두 테이블에 org_id·project_id 를 **부모 doc 에서 backfill** 하며 추가. doc_id FK 가 ON DELETE
CASCADE 라 orphan 0 → 모든 행 backfill → NN 으로 잠금(model 정합). ⚠️baseline 미변경: 이 컬럼은
post-0096 추가(0096 스냅샷엔 원래 없음·superseded_by(0130)와 동형)·fresh-DB CI 가 이 마이그로 적용.
⭐create_all(모델 기준·컬럼 있음)이 가린 drift라 검증은 반드시 migrated DB(alembic head)로.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0131"
down_revision = "0130"
branch_labels = None
depends_on = None

_TABLES = ("doc_revisions", "doc_comments")


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    for tbl in _TABLES:
        cols = {c["name"] for c in insp.get_columns(tbl)}
        if "org_id" not in cols:
            op.add_column(tbl, sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=True))
        if "project_id" not in cols:
            op.add_column(tbl, sa.Column("project_id", postgresql.UUID(as_uuid=True), nullable=True))
        # 부모 doc 에서 backfill(CASCADE FK 라 모든 행에 부모 존재). soft-delete 된 doc 도 행은 남아 매칭.
        op.execute(
            f"UPDATE {tbl} t SET org_id = d.org_id, project_id = d.project_id "
            f"FROM docs d WHERE d.id = t.doc_id AND (t.org_id IS NULL OR t.project_id IS NULL)"
        )
        # backfill 완료 → NN 잠금(model 정합). orphan 있으면 여기서 loud-fail(silent drift 방지).
        op.alter_column(tbl, "org_id", nullable=False)
        op.alter_column(tbl, "project_id", nullable=False)
        idx = f"ix_{tbl}_org_id"
        existing_idx = {i["name"] for i in insp.get_indexes(tbl)}
        if idx not in existing_idx:
            op.create_index(idx, tbl, ["org_id"])


def downgrade() -> None:
    for tbl in _TABLES:
        op.execute(f"DROP INDEX IF EXISTS ix_{tbl}_org_id")
        op.drop_column(tbl, "project_id")
        op.drop_column(tbl, "org_id")
