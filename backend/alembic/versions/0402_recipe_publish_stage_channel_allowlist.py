"""플랫폼 레시피 발행 stage에 허용 채널 종류(capability.channels) 선언

Revision ID: 0402
Revises: 0401

story #4239(PO 확정 2026-09-24): 적용 창의 발행자 «채널 선택»이 org의 active 연결 전부를 보여 줘 뉴스레터 «캠페인 생성»에
Instagram·WordPress·webhook을 묶을 수 있었다(예약 발행은 «바인딩 연결 = 초안 연결»이라 잘못이 발행 실패로야 드러남). 발행
stage(target="channel_connection")가 받을 수 있는 채널 종류를 정의에 선언한다 — 적용 창이 이 목록으로 거르고, 적용 API는
밖이면 422(`apply_recipe_role_bindings`), `validate_stage_metadata`가 모양을 강제한다.

목록 근거는 `channel_adapters.CHANNEL_ADAPTERS` 실측(PO 확정):
- 뉴스레터 `campaign_created`: 뉴스레터 어댑터(stibee)뿐.
- SNS 텍스트 `published`: threads · x · facebook(+샌드박스). instagram은 `image_required=True`라 텍스트만으로 발행 불가 → 제외.
- 카드뉴스 `published`: 여러 장 이미지 — instagram · facebook(+샌드박스). threads는 `image_max_count=1`, x는 이미지 필드 없음.
- 영상 `published`: instagram · youtube · facebook(+샌드박스).
blog 종류(wordpress · webhook · ghost · hosted_site)와 meta_ads는 어느 목록에도 없다.

각 stage의 `capability.channels` 한 경로만 `jsonb_set`으로 바꾼다(0400 `action_i18n` · 0401 `approval` 등 나머지 그대로).
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0402"
down_revision = "0401"
branch_labels = None
depends_on = None

CHANNEL_ALLOWLIST: dict[tuple[str, str], list[str]] = {
    ("preset.marketing.newsletter", "campaign_created"): ["stibee", "stibee_sandbox"],
    ("preset.marketing.social_text_post", "published"): ["threads", "x", "facebook", "sandbox", "x_sandbox", "facebook_sandbox"],
    ("preset.marketing.social_card_news", "published"): ["instagram", "facebook", "instagram_sandbox", "facebook_sandbox"],
    ("preset.marketing.video_production", "published"): [
        "instagram", "youtube", "facebook", "instagram_sandbox", "youtube_sandbox", "facebook_sandbox",
    ],
}


def upgrade() -> None:
    bind = op.get_bind()
    for (key, stage), channels in CHANNEL_ALLOWLIST.items():
        bind.execute(
            sa.text(
                "UPDATE event_definitions "
                "SET stage_metadata = jsonb_set(stage_metadata, CAST(:path AS text[]), CAST(:channels AS jsonb), true), "
                "    version = version + 1 "
                "WHERE org_id IS NULL AND key = :key "
                "  AND stage_metadata->:stage->'capability'->>'target' = 'channel_connection'"
            ),
            {"path": "{%s,capability,channels}" % stage, "channels": json.dumps(channels), "key": key, "stage": stage},
        )


def downgrade() -> None:
    bind = op.get_bind()
    for (key, stage) in CHANNEL_ALLOWLIST:
        bind.execute(
            sa.text(
                "UPDATE event_definitions "
                "SET stage_metadata = stage_metadata #- CAST(:path AS text[]), version = version - 1 "
                "WHERE org_id IS NULL AND key = :key AND stage_metadata->:stage->'capability' ? 'channels'"
            ),
            {"path": "{%s,capability,channels}" % stage, "key": key, "stage": stage},
        )
