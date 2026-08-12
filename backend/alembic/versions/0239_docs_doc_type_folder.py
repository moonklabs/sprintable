"""story #2974(카디르 QA REQUEST_CHANGES·PO 방향 결정 2026-08-12, 실측 후 2차 결정) —
docs_doc_type_check에 'folder'를 허용하고, is_folder 값을 doc_type='folder'로 backfill한 뒤
죽은 is_folder boolean 컬럼을 은퇴시킨다.

배경: Doc.is_folder(models/doc.py)는 이미 doc_type=="folder"의 derived property로 전환됐고
FE/응답 스키마도 그 계약 위에 서 있는데, docs_doc_type_check가 'folder'를 허용하지 않아
is_folder:true로 생성하는 실 경로가 CheckViolationError로 죽었다(#2978이 처음 이 경로를 열어
드러남 — mock 테스트는 실 PG 제약을 못 잡는다, [[feedback_baseline_check_ci_sqlite_blindspot]]).

PO 결정 — 방향 (a): doc_type에 'folder' 추가(별도 boolean 부활 아님). 근거: ① 모델·응답
스키마·FE가 전부 이미 doc_type=="folder" 계약 위에 서 있다(제약만 못 따라옴). ② 별도 boolean은
「doc_type=prd이면서 is_folder=true」같은 모순 상태를 허용해 새 제약이 또 필요해진다. ③ 죽은
컬럼 부활은 «은퇴했는데 주소가 살아 있는» 병을 키운다.

실측(PO, 2026-08-12): dev=총 919 docs 중 is_folder=true 83건(전부 2026-04-23 이전 유산 — ORM이
derived property로 전환되며 「폴더성」을 잃은 행들. 자식 251건이 지금도 그 아래 매달려 있다).
prod=총 693 중 0건(깨끗). ⇒ 조건부 drop이 아니라 **backfill-then-drop**이 맞는 처방 —
dev의 83건을 그냥 두고 컬럼만 지우면 그 폴더들이 doc_type='page'인 채로 남아(#2178 기본값)
트리 구조(자식 251건)의 의미가 깨진다. 순서: ① CHECK 확장(backfill이 새 CHECK를 통과해야
하므로 먼저) → ② backfill(is_folder=true 행을 doc_type='folder'로) → ③ 컬럼 drop(데이터
손실 0 — 은퇴 완성). prod는 backfill 대상 0건이라 no-op으로 안전하게 통과한다.

⚠️downgrade 손실 고지: is_folder=true였던 행의 **원래 doc_type 값**(대부분 'page' — #2178
기본값)은 backfill이 덮어써 복원 불가능하다(표준 backfill 마이그레이션의 통상적 손실 —
스키마 형태만 되돌리는 것이 목적이지 과거 정확한 페이로드를 복원하는 것이 아니다).
downgrade는 is_folder=true 상태(폴더성 보존)로 되돌리되 doc_type은 'page'로 리셋한다.
"""
from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0239"
down_revision = "0238"
branch_labels = None
depends_on = None

_FULL = "('prd', 'ac', 'spec', 'policy', 'general', 'page', 'sprint_report', 'folder')"
_OLD = "('prd', 'ac', 'spec', 'policy', 'general', 'page', 'sprint_report')"


def _docs_has_is_folder_column(bind) -> bool:
    # baseline/schema.sql이 이미 이 컬럼 없는 상태로 재덤프된 fresh-provision 경로(REVISION=0096
    # 스탬프+그 위에 0097… 재생 — env.py fresh-DB 경로)에서는 이 마이그가 없는 컬럼을 다시
    # 참조하면 안 되므로, 0207의 CHECK-widen(부재에 idempotent)과 달리 존재를 먼저 확인한다.
    return bool(
        bind.execute(
            sa.text(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name = 'docs' AND column_name = 'is_folder'"
            )
        ).scalar()
    )


def upgrade() -> None:
    op.execute("ALTER TABLE docs DROP CONSTRAINT IF EXISTS docs_doc_type_check")
    op.execute(f"ALTER TABLE docs ADD CONSTRAINT docs_doc_type_check CHECK (doc_type IN {_FULL})")

    bind = op.get_bind()
    if not _docs_has_is_folder_column(bind):
        return  # 이미 은퇴됨(fresh-provision 경로) — no-op.

    backfilled = bind.execute(
        sa.text("UPDATE docs SET doc_type = 'folder' WHERE is_folder = true")
    ).rowcount
    if backfilled:
        print(f"docs.doc_type backfilled to 'folder' for {backfilled} row(s) (was is_folder=true)")  # noqa: T201

    op.drop_column("docs", "is_folder")


def downgrade() -> None:
    op.execute("ALTER TABLE docs DROP CONSTRAINT IF EXISTS docs_doc_type_check")

    bind = op.get_bind()
    if not _docs_has_is_folder_column(bind):
        op.add_column(
            "docs",
            sa.Column("is_folder", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
        # doc_type='folder' 행을 is_folder=true로 역-backfill(폴더성 보존) 후 doc_type을
        # 구 CHECK가 받아들이는 값으로 리셋 — 원래 값은 복원 불가(위 손실 고지 참고).
        bind.execute(sa.text("UPDATE docs SET is_folder = true WHERE doc_type = 'folder'"))
        bind.execute(sa.text("UPDATE docs SET doc_type = 'page' WHERE doc_type = 'folder'"))

    op.execute(f"ALTER TABLE docs ADD CONSTRAINT docs_doc_type_check CHECK (doc_type IN {_OLD})")
