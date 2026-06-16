"""docs 참조 FK 복구 — baseline 소실 FK 7개 (story 5b246134).

5b246134 감사서 적출: docs(.id)를 참조하는 7개 (table.column)에 FK 부재 — 0007 등에서
정의됐을 FK가 baseline schema.sql(0096)에 소실(0007 doc_comments/doc_revisions 가설 확증).
docs PK는 0107(#1366) 복원돼 FK 성립 가능. dev 실측: 복구 대상 7개 FK 전무 + **orphan 전
테이블 0**(FK ADD 전부 SAFE·cleanup 불요). 기존 2개(doc_share_tokens·doc_slug_aliases)는
post-0096라 이미 FK 보유 → IF NOT EXISTS skip.

ondelete(ORM 원안/5b246134 결정):
  doc_comments.doc_id      → CASCADE   (doc 삭제 시 댓글 삭제)
  doc_revisions.doc_id     → CASCADE   (doc 삭제 시 리비전 삭제)
  epic_docs.doc_id         → CASCADE   (link — doc 삭제 시 링크 삭제)
  story_docs.doc_id        → CASCADE   (link)
  memo_doc_links.doc_id    → CASCADE   (link)
  docs.parent_id           → SET NULL  (부모 doc 삭제 시 자식은 최상위로)
  sprints.report_doc_id    → SET NULL  (회고 doc 삭제 시 sprint 참조만 해제)

⚠️ idempotent — constraint 명(<table>_<col>_fkey, 기존 2개와 동일 컨벤션) 부재 시에만 ADD.
재실행·fresh DB(이미 ORM이 FK 생성)서도 안전(IF NOT EXISTS skip). orphan 0이라 ADD 시 검증
통과(orphan>0이면 ADD 실패하므로 prod-apply 전 preflight 필수 — docs_fk_parity_audit.sql §2).
"""
from alembic import op

revision = "0121"
down_revision = "0120"
branch_labels = None
depends_on = None


# (table, column, ondelete) — 복구 대상 7. constraint 명 = <table>_<column>_fkey.
_FKS = [
    ("doc_comments", "doc_id", "CASCADE"),
    ("doc_revisions", "doc_id", "CASCADE"),
    ("epic_docs", "doc_id", "CASCADE"),
    ("story_docs", "doc_id", "CASCADE"),
    ("memo_doc_links", "doc_id", "CASCADE"),
    ("docs", "parent_id", "SET NULL"),
    ("sprints", "report_doc_id", "SET NULL"),
]


def upgrade() -> None:
    for table, column, ondelete in _FKS:
        fk_name = f"{table}_{column}_fkey"
        op.execute(
            f"""
            DO $$
            BEGIN
                IF to_regclass('public.{table}') IS NOT NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM pg_constraint
                       WHERE conname = '{fk_name}'
                         AND conrelid = 'public.{table}'::regclass
                   ) THEN
                    ALTER TABLE public.{table}
                        ADD CONSTRAINT {fk_name}
                        FOREIGN KEY ({column}) REFERENCES public.docs(id)
                        ON DELETE {ondelete};
                END IF;
            END $$;
            """
        )


def downgrade() -> None:
    # 드리프트(소실 FK) 복구이므로 되돌리지 않는다 — FK를 drop하면 원래 결함(참조 무결성
    # 부재)을 재현한다. (0107 docs_pkey / 0113 epics_pkey / 0114 / 0120 plan_features_pkey와
    # 동일 정책: 드리프트 교정 마이그는 no-op downgrade.)
    pass
