"""story #3064(E-MOBILE·macOS): push_devices에 macOS/APNs 지원 추가.

macOS(Tauri) 앱은 Expo 런타임이 아니라 Expo push 토큰을 만들 수 없다 — 네이티브 APNs raw
device token(hex)을 등록해야 한다. 기존 `expo_push_token`(NOT NULL UNIQUE) 컬럼은 Expo
경로(ios/android) 그대로 두고, 플랫폼별 컬럼을 분리한다(신규 `apns_device_token`) — 발송기
(expo_push.py)·repository.upsert의 기존 conflict target을 건드리지 않기 위함.

⚠️prod 승격 前 필수: 이 마이그는 dev(sprintable-dev, private IP, Cloud Run Job 경유 실측)
GROUP BY platform 스캔으로 "모든 기존 행이 expo_push_token NOT NULL"임을 확認한 뒤 작성됐다
(2026-08-25, ROWS 3: platform=NULL n=1 has_expo=1, android n=14 has_expo=14, ios n=1 has_expo=1 —
전부 null_expo=0). prod는 gcloud 게이트라 이 세션에서 재지 못했다 — **prod 배포 前 반드시 같은
GROUP BY platform, count(*), count(expo_push_token) 스캔을 prod에서 재실행**해 위반 행이
있는지 확認할 것. 위반 행이 있으면 이 CHECK를 그대로 올리지 말고 NOT VALID로 추가한 뒤 그
행들을 정리(백필 또는 폐기)하고 VALIDATE CONSTRAINT로 마무리하는 2단계로 바꿀 것(카디르
QA·페드루 PO 합의 정공법, dev 스캔이 클린이라 여기선 1단계로 감).

Revision ID: 0278
Revises: 0277
Create Date: 2026-08-25
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0278"
down_revision = "0277"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("push_devices", sa.Column("apns_device_token", sa.Text(), nullable=True))
    op.create_unique_constraint(
        "uq_push_devices_apns_device_token", "push_devices", ["apns_device_token"]
    )
    op.alter_column("push_devices", "expo_push_token", existing_type=sa.Text(), nullable=True)

    op.drop_constraint("push_devices_platform_check", "push_devices", type_="check")
    op.create_check_constraint(
        "push_devices_platform_check",
        "push_devices",
        "platform IS NULL OR platform IN ('ios', 'android', 'macos')",
    )
    # story #3064: 플랫폼별 토큰 상호배타 — macos는 apns_device_token만, 그 외(레거시 platform
    # IS NULL 포함)는 expo_push_token 필수. dev GROUP BY 스캔(위 docstring)으로 기존 행 전부가
    # 우변을 만족함을 확認했으므로 스캔 없이 1단계로 올린다.
    op.create_check_constraint(
        "push_devices_token_platform_exclusive_check",
        "push_devices",
        "(platform = 'macos' AND apns_device_token IS NOT NULL AND expo_push_token IS NULL) "
        "OR (platform IS DISTINCT FROM 'macos' AND expo_push_token IS NOT NULL)",
    )


def downgrade() -> None:
    op.drop_constraint("push_devices_token_platform_exclusive_check", "push_devices", type_="check")
    op.drop_constraint("push_devices_platform_check", "push_devices", type_="check")
    op.create_check_constraint(
        "push_devices_platform_check",
        "push_devices",
        "platform IS NULL OR platform IN ('ios', 'android')",
    )
    op.alter_column("push_devices", "expo_push_token", existing_type=sa.Text(), nullable=False)
    op.drop_constraint("uq_push_devices_apns_device_token", "push_devices", type_="unique")
    op.drop_column("push_devices", "apns_device_token")
