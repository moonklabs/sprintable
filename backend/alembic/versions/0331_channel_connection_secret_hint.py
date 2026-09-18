"""story #3492(Phase1·마케팅운영·소형, 페드루 PO 決定 2026-09-05) —
`channel_connections.secret_hint` 신설.

유나 10회차 #3823 E 관찰 — 붙여넣기(pasted_secret) 연결(WordPress·webhook)은 지금
해제→새로 연결뿐이라 자격을 바꿀 때마다 connection_id가 갈려 draft·발행 이력·
external_publish 게이트 scope_key(story #3478, connection_id 단위)가 끊긴다.
「제자리 교체」(PATCH .../credentials, id 불변)를 열면서, 3653a18c §2 규격 3(재방문
시 끝 4자리만 표시)의 근거 컬럼을 신설한다 — `app_id_suffix`(channel_connections.py
::_app_id_suffix)와 동형으로 원문은 저장하지 않고 끝 4자리만 저장·반환한다.

oauth 채널(Threads 등)은 이 값을 안 쓴다(NULL 그대로, credential_kind="pasted_secret"
경로만 채운다).

Revision ID: 0331
Revises: 0330
Create Date: 2026-09-05

⚠️0330(#3837)이 아직 develop 미착지 — 스택(#3829→#3835→#3836→#3837) 순서대로
착지된 뒤 이 마이그가 체인의 다음 자리를 잇는다(0327/#3474 이후 이 세션 전체가
써 온 관례와 동일 — 열린 PR의 alembic/versions까지가 SSOT)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0331"
down_revision = "0330"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("channel_connections", sa.Column("secret_hint", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("channel_connections", "secret_hint")
