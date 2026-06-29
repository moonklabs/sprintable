"""E-INFRA ③ B: v1.5 릴노트에 스토리지 용량경고 항목 추가 (de-hardcode 데이터·dev+prod 일관).

선생님 결정: 1.6 아님·v1.5 에 += . S8 용량경고(실 라이브 기능)를 v1.5 items 에 append. 데이터주도지만
prod 일관·baseline 재현 위해 migration(0142 seed 위 idempotent UPDATE).

idempotent: 이미 그 항목이 있으면(items @> ) skip. v1.5 행 없으면(미시드) no-op.
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0143"
down_revision = "0142"
branch_labels = None
depends_on = None

_NOTE_KEY = "2026-06-v1-5"
_ITEM = [{"text": "저장공간이 한도에 가까워지면 미리 알려드려요."}]


def upgrade() -> None:
    item_json = json.dumps(_ITEM, ensure_ascii=False)
    op.execute(
        sa.text(
            "UPDATE release_notes SET items = items || CAST(:item AS jsonb) "
            "WHERE note_key = :k AND NOT (items @> CAST(:item AS jsonb))"
        ).bindparams(item=item_json, k=_NOTE_KEY)
    )


def downgrade() -> None:
    # 항목 제거(best-effort·jsonb - 는 객체 배열 직접 미지원이라 재구성). 무손실 롤백 위해 no-op 허용.
    pass
