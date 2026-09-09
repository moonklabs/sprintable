"""story #3745(UI 점검 B·D2 잔존, 페드루 PO 決 2026-09-09) — 이벤트 정의 「이름 없는 정의」
잔존 데이터 처방 ③. PO 라이브 실측(10:15Z)에서 `preset.steer.instruct`(0274 시드) name이
빈 문자열로 남아 화면에 코드 키가 그대로 서던 실 결함 5건 중 프리셋 1건.

PO 判(2026-09-09) — 이름은 정의를 만든 쪽이 채운다: 프리셋은 우리 seed이므로 우리가 채운다
(org 커스텀 4건은 조직이 새 편집 UI로 직접 채운다 — PO 백필 없음, 이 마이그 범위 밖).

이름 "방향 전환"은 0274의 block_template 헤더("방향 전환")를 그대로 재사용 — 새 낱말을
짓지 않는다.
"""
from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0358"
down_revision = "0357"
branch_labels = None
depends_on = None

_KEY = "preset.steer.instruct"
_NAME = "방향 전환"


def upgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions SET name = :name "
            "WHERE org_id IS NULL AND key = :key AND name = ''"
        ),
        {"name": _NAME, "key": _KEY},
    )


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text(
            "UPDATE event_definitions SET name = '' "
            "WHERE org_id IS NULL AND key = :key AND name = :name"
        ),
        {"key": _KEY, "name": _NAME},
    )
