"""story #3813(Phase3·3-4 PR2, 페드루 PO 確定 2026-09-12) — 뉴스레터(ESP=전달만)
발송 게이트 봉인 3축 + `publication_commands.content_kind` CHECK에 "newsletter_send"
추가 + `channel_post_versions.channel_payload`(채널별 변형 payload 공유 슬롯, 컬럼
이름에 채널 이름 안 붙임 — story #3808 PR5 X 스레드 변형도 재사용 예정) 신설.

## gate.sealed_newsletter_*
ads_boost의 sealed_ads_*(0364 이전 마이그)와 완전히 같은 「변경=재승인」 기전을
새 3열(segment_name·scheduled_at·version_id)로 복제한다 — sealed_ads_boost_
version_id를 재사용하지 않는 이유는 gate.py 모델 주석 참고(gate_type마다 독립된
재봉인 세대 카운터가 필요, 서로 뒤섞이면 뜻이 흐려진다).

## content_kind CHECK
0364가 "ads_boost" 추가할 때 쓴 정확한 패턴(drop_constraint+create_check_constraint,
old/new SQL 상수화) 재사용. 모델 미러(publication_command.py)도 같은 커밋에서
같이 고친다(0323→0340 사고 재발 방지 관례, 0364 주석 그대로)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0370"
down_revision = "0369"
branch_labels = None
depends_on = None

_OLD_CHECK_SQL = "content_kind IN ('channel_post', 'site_post', 'comment_reply', 'ads_boost')"
_NEW_CHECK_SQL = "content_kind IN ('channel_post', 'site_post', 'comment_reply', 'ads_boost', 'newsletter_send')"


def upgrade() -> None:
    op.add_column("gate", sa.Column("sealed_newsletter_segment_name", sa.Text(), nullable=True))
    op.add_column("gate", sa.Column("sealed_newsletter_scheduled_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("gate", sa.Column("sealed_newsletter_version_id", UUID(as_uuid=True), nullable=True))

    op.add_column("channel_post_versions", sa.Column("channel_payload", JSONB(), nullable=True))

    op.drop_constraint("ck_publication_commands_content_kind", "publication_commands", type_="check")
    op.create_check_constraint("ck_publication_commands_content_kind", "publication_commands", _NEW_CHECK_SQL)


def downgrade() -> None:
    op.drop_constraint("ck_publication_commands_content_kind", "publication_commands", type_="check")
    op.create_check_constraint("ck_publication_commands_content_kind", "publication_commands", _OLD_CHECK_SQL)

    op.drop_column("channel_post_versions", "channel_payload")

    op.drop_column("gate", "sealed_newsletter_version_id")
    op.drop_column("gate", "sealed_newsletter_scheduled_at")
    op.drop_column("gate", "sealed_newsletter_segment_name")
