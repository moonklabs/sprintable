"""채팅 세션 정책 회귀 — uq_conversations_dm_pair drop (db75ecd0 EF-S2 AC1).

선생님 지시(ce13ff0a): "이전 정책과 같이 신규 채팅 세션으로 생성되도록 회귀". 179db213(마이그 0100)이
넣은 1-DM-per-pair dedup unique index 를 제거해 동일 2인 pair여도 매 "new conversation" 마다 신규
conversation(=세션) 공존(각 1주제·hermes 세션별). create_conversation 의 _find_existing_dm 재사용 +
IntegrityError DM-reuse fallback 도 함께 제거(코드).

⚠️ "방 1개 제약"에만 국한된 회귀 — 보존 불변식 3종은 불변: ①메시지 dedup(send_message·별개)
②_enforce_agent_creator_policy(creator 동석/allow_list) ③thread=스토리. (agent_comms_unified 보안 핵심.)

`dm_pair_key` 컬럼은 유지(2인 룸 태깅·non-unique). drop index = backward-safe(데이터 변화 0·구 코드의
_find_existing_dm 은 기존 DM 있으면 반환·없으면 신규라 migrate-first 무해).

Revision ID: 0111
Revises: 0110
Create Date: 2026-06-10
"""
from alembic import op

revision = "0111"
down_revision = "0110"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_conversations_dm_pair")


def downgrade() -> None:
    # 0100 정의 복원. 단, drop 이후 동일 pair 다중 DM 이 생겼다면 재생성이 실패할 수 있음
    # (정책 회귀 롤백은 사전 dedup 필요 — 비상시 수동).
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_conversations_dm_pair "
        "ON conversations (org_id, project_id, dm_pair_key) "
        "WHERE type = 'dm' AND dm_pair_key IS NOT NULL"
    )
