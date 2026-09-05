"""story #3547(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06) — Facebook Page 연결의
페이지 선택 중간 상태. Facebook Login 콜백은 장기 유저 토큰을 받은 뒤 `/me/accounts`
로 그 유저가 관리하는 페이지 목록을 받아야 하고, 페이지가 2개 이상이면 사람이 골라야
한다(1개면 콜백에서 즉시 확정, 0개면 실패) — 기존 `channel_oauth_state.py`(JWT, 단발
왕복)는 이 "고른 뒤에야 끝나는" 중간 상태를 못 들고 있어 새 서버 임시 테이블을 둔다.

JWT 탈락 사유: 장기 유저 토큰이 브라우저로 나가면 그대로 노출된다. 기존 channel_
connections 행 재사용 탈락 사유: status 값들을 소비처가 이미 판정에 쓰고 있어(예:
active/revoked) "아직 페이지 미확정" 상태를 그 안에 끼워 넣으면 그 판정을 오염시키고,
account_id NOT NULL이라 가짜값을 채워야 한다.

TTL 15분·단회 사용(select 성공 시 즉시 삭제) — 만료분은 새 Cloud Scheduler 잡 0으로
`/publication-commands` tick에 피기백해 스윕한다(cron.py, 3497/3527과 동형 사상).
FK 없음(channel_connections·channel_app_credentials와 동일 관례 — 그라운딩 §9)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0342"
down_revision = "0341"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "channel_oauth_pending_selections",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("requester_member_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("encrypted_user_token", sa.Text(), nullable=False),
        # [{"page_id": "...", "name": "..."}, ...] — 페이지 토큰은 여기 안 둔다(select
        # 단계가 /me/accounts를 재호출해 그때 얻는다, 캐시된 값을 안 믿는다).
        sa.Column("candidates", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False, index=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), onupdate=sa.func.now(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("channel_oauth_pending_selections")
