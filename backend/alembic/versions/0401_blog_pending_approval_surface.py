"""blog 레시피 «승인 대기» stage — 승인 자리가 stage 밖(초안 게이트)임을 정의에 선언

Revision ID: 0401
Revises: 0400

story #4174 후속(PO 2026-09-24): 블로그 적용 창의 «디렉터» 묶음에 «사람» 배지가 달린 «승인 대기» 줄이 사람 선택을 요구했다
(적용하기가 그 선택 전까지 비활성). `pending_approval`은 Director(사람) · 게이트 없음이라 적용 창이 «사람이 일하는 단계»와
구별할 신호가 없었다 — 실제로는 Creator 에이전트가 초안을 제출한 뒤 이 stage를 발행하고, 발행 승인은 결재함의 **초안
게이트**에서 한다(그 승인자는 게이트 쪽 규칙이 정한다). 정의가 스스로 말하게 한다: `approval: {"surface": "draft_gate"}`
(닫힌 어휘 · 승인자는 적지 않음 — `event_definition_registry.validate_stage_metadata`가 강제). 적용 창은 이 선언이 있는 사람
stage를 선택 없는 읽기 전용 자리로 그린다. 런타임 코드 변화 0 — 제출 role_mapping에 이 stage는 원래 없다.

이 한 경로만 `jsonb_set`으로 바꾼다(0400이 같은 stage에 넣은 `action_i18n` 등 나머지는 그대로).
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0401"
down_revision = "0400"
branch_labels = None
depends_on = None

_KEY = "preset.marketing.blog_article"
_PATH = "{pending_approval,approval}"


def upgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "UPDATE event_definitions "
            "SET stage_metadata = jsonb_set(stage_metadata, CAST(:path AS text[]), CAST(:value AS jsonb), true), "
            "    version = version + 1 "
            "WHERE org_id IS NULL AND key = :key AND stage_metadata ? 'pending_approval' "
            "  AND NOT (stage_metadata->'pending_approval' ? 'approval')"
        ),
        {"path": _PATH, "value": '{"surface": "draft_gate"}', "key": _KEY},
    )


def downgrade() -> None:
    op.get_bind().execute(
        sa.text(
            "UPDATE event_definitions "
            "SET stage_metadata = stage_metadata #- CAST(:path AS text[]), version = version - 1 "
            "WHERE org_id IS NULL AND key = :key AND stage_metadata->'pending_approval' ? 'approval'"
        ),
        {"path": _PATH, "key": _KEY},
    )
