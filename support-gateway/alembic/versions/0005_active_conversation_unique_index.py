"""story #3278(지원v1·후속) — (org_id, external_user_id)당 활성 상담(ended_at IS NULL)
최대 1개를 DB 제약으로 강제.

출처: PR#3667 카디르 QA 참고사항(2026-09-01, 비차단) — story #3276이 만든 "활성 최대 1개"
불변식이 앱 로직(`_get_or_create_active_conversation`)에만 있고 DB 제약이 없어, 동시 start
요청 레이스에서 이론상 활성 2개가 생길 수 있다.

partial unique index `(org_id, external_user_id) WHERE ended_at IS NULL`. `external_user_id`
IS NULL인 레거시 봉인 행(story #3276 이전, "org당 1스레드" 시절)은 이 인덱스 대상에서
자연히 제외된다 — Postgres 유니크 인덱스는 NULL끼리 서로 다른 값으로 취급하므로, NULL
external_user_id 행이 여러 개 있어도(레거시) 위반이 안 된다. WHERE 절에 명시로 제외하지
않아도 되지만, 아래 선-정리 UPDATE에서는 명시로 건너뛴다(레거시 행은 새 불변식 적용
대상이 아니므로 손대지 않는다 — story #3276 "봉인" 원칙 그대로).

마이그레이션 전 기존 데이터 정리(스토리 처방 그대로) — 인덱스 생성 전, 같은
(org_id, external_user_id)에 활성 상담이 2개 이상이면 가장 최근 것만 남기고 나머지는
`ended_at=now()`로 종료 처리한다(정리 정책: "가장 최근 활성 유지" — 위젯이 재오픈 시
사용자가 마지막으로 보고 있던 대화가 이어지는 게 가장 자연스럽다). v1은 단일 위젯
클라이언트라 실제로 이 분기를 탈 데이터는 거의 없을 것으로 예상(스토리 자체 서술)이지만,
있어도 마이그레이션이 죽지 않고 스스로 정리한다.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

_INDEX_NAME = "ux_support_conversations_org_user_active"

_CLEANUP_SQL = """
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY org_id, external_user_id
               ORDER BY created_at DESC, id DESC
           ) AS rn
    FROM support_conversations
    WHERE ended_at IS NULL AND external_user_id IS NOT NULL
)
UPDATE support_conversations
SET ended_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
"""


def upgrade() -> None:
    op.execute(_CLEANUP_SQL)
    op.create_index(
        _INDEX_NAME,
        "support_conversations",
        ["org_id", "external_user_id"],
        unique=True,
        postgresql_where=sa.text("ended_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index(_INDEX_NAME, table_name="support_conversations")
