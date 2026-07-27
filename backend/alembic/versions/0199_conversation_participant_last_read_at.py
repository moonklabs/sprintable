"""story #1976 (E-CHAT-REALTIME 트랙A): conversation_participants.last_read_at — read state 서버 truth.

Revision ID: 0199
Revises: 0198
Create Date: 2026-07-17

배경: chat-realtime-unread-diagnosis(#1975) 갭 A — 서버 read state truth 부재. unread 배지가
클라 세션 휘발 카운터(SSE 수신 시 +1, 영속/차감/mark-read 전무)라 콜드스타트·새 탭에서 리셋됨.
last_read_at을 서버 truth로 신설 — unread_count = last_read_at 이후 메시지(sender IS DISTINCT
FROM 나) 카운트로 대체(doc: chat-realtime-track-a-read-state-design §2).

NULL=한 번도 안 읽음(과거 참가자 전원 포함 — 백필 없음, 마이그 시점 기존 row는 전량 NULL로
시작해 다음 조회 시 전체 unread로 보인다 — 의도된 동작, 최초 mark-read 호출로 해소).
default 없음(server_default 미부여) — INSERT 시 항상 NULL(신규 참가자="아직 안 읽음",
muted_at과 동형 시맨틱). additive·nullable — 구코드 호환. idempotent(컬럼 부재 시만 추가),
0115(muted_at 신설) 스타일 정합.

**백필은 이 마이그 스코프 밖**(설계 doc §6-5 열린 질문 — 배포 직후 전체 unread UX 허용 가능
여부는 선생님 확認 대기, 월요일로 밀림). 이 마이그는 순수 ADD COLUMN만 수행하며 UPDATE는
절대 포함하지 않는다. 백필 여부/전략은 후속 결정 대기.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0199"
down_revision = "0198"
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    cols = {c["name"] for c in insp.get_columns("conversation_participants")}
    if "last_read_at" not in cols:
        op.add_column(
            "conversation_participants",
            sa.Column("last_read_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    cols = {c["name"] for c in insp.get_columns("conversation_participants")}
    if "last_read_at" in cols:
        op.drop_column("conversation_participants", "last_read_at")
