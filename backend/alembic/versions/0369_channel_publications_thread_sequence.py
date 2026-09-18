"""story #3808(Phase3·3-3 PR2, 페드루 PO 確定 2026-09-11) — `channel_publications`
스레드 N건 지원. 기존 `UNIQUE(gate_id, version_id)`는 "그 gate+version 조합은
발행물 1건"을 전제한다(story f8f7cb0f 원 설계 — 단일 게시물 채널군 전제) — X
스레드(연속 게시)는 같은 gate+version 아래 N개의 개별 tweet(각자 external_id·
permalink)이 필요해 이 전제가 막는다.

`sequence`(0345류 sealed_* 관례와 달리 이건 channel_publications 자체의 열,
publication_commands.toggle_seq 선례 §0364와 동형 사상) — 스레드의 몇 번째
게시물인지(0=헤드). 다른 채널(threads/instagram/facebook 등)은 이 열이 항상
server_default 0 그대로라 기존 UNIQUE 의미가 전혀 안 바뀐다(additive, 회귀 0 —
0364 toggle_seq 선례와 같은 안전성 논증).

## downgrade 주의
실 운영에서 스레드 기능이 쓰인 뒤(같은 (gate_id, version_id)에 sequence만 다른
행이 2개 이상 존재한 뒤) downgrade하면 옛 2열 UNIQUE 재생성이 중복 위반으로
실패한다 — 0364 선례와 같은 성격의 알려진 제약(로컬 검증 시점엔 그런 행이
없다는 전제로만 downgrade 지원).

Revision ID: 0369
Revises: 0368
Create Date: 2026-09-11
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0369"
down_revision = "0368"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "channel_publications",
        sa.Column("sequence", sa.Integer(), nullable=False, server_default="0"),
    )
    op.drop_constraint("uq_channel_publications_gate_version", "channel_publications", type_="unique")
    op.create_unique_constraint(
        "uq_channel_publications_gate_version_sequence",
        "channel_publications",
        ["gate_id", "version_id", "sequence"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_channel_publications_gate_version_sequence", "channel_publications", type_="unique")
    op.create_unique_constraint(
        "uq_channel_publications_gate_version", "channel_publications", ["gate_id", "version_id"],
    )
    op.drop_column("channel_publications", "sequence")
