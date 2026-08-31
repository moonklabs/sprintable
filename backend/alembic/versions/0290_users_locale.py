"""story #3205(선생님 방향 결정 2026-08-29) — users에 locale 판별원 신설.

발송 메일 7종이 수신자 무관 고정 언어였던 문제(트랜잭셔널 3종+리마인드+초대=ko 고정,
운영 알림 2종=en 고정)의 근본은 "유저 로케일을 물어볼 곳이 없다"였다 — 판별원 실측
결과 users에 locale 컬럼 없음, FE도 쿠키 전용(story 11f1087c 크루스 — 라이브 렌더용
locale은 의도적으로 DB에 안 둔다)이라 async 발송(cron 리마인드 등, 살아있는 요청이
없는 경로) 시점엔 그 쿠키를 읽을 수 없다.

이 컬럼은 그 크루스를 뒤집는 게 아니라 다른 축이다 — FE 라이브 렌더링은 여전히 쿠키
기준(그대로 유지), 이건 "계정에 매달린, 요청 밖에서도 읽을 수 있는" 발송 전용 신호.
nullable — 가입 시 Accept-Language로 1회 포착(추측 아님, agents.py/role_templates.py 등
기존 여러 엔드포인트가 이미 쓰는 resolve_locale_from_request와 동일 파싱 재사용)하되
기존 유저는 채워지지 않는다. 폴백 규칙은 코드(resolve_locale, DEFAULT_LOCALE="ko")와
동일 — 이 마이그레이션은 백필하지 않는다(과거 유저의 실제 선호를 아는 방법이 없어
추측 백필은 오히려 거짓 신호).

Revision ID: 0290
Revises: 0289
Create Date: 2026-08-29

"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0290"
down_revision = "0289"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("locale", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "locale")
