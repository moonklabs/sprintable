"""story #4088(E-RECIPE-1, PO 분담조정 2026-09-21 07:18Z, "2/2") — 리허설 1호가 잡은 자기설명
멘션 구멍 3개 중 ①의 선언 자리. 댄(Creator 에이전트)이 verification/editing stage를 발행할
때, 만든 영상을 채널 포스트 초안에 첨부하는 방법(story #4088 1/2가 연 `attach_channel_post_
video` MCP 도구, 플러그인 0.9.14)을 자기설명 멘션이 안내하지 않았다 — role/action만으로는
"무엇을 만들지"는 알아도 "그 산출물을 어디에 편입시키는지"를 알 길이 없었다.

## 처방(하드코딩 0 — stage_metadata.capability 선언에서 유도)
`live_generation`이 이미 쓰는 `capability: {kind: "generate"}` 관례를 그대로 재사용한다
(발명 0). `verification`·`editing`에 `capability: {kind: "attach_video"}`를 신설 —
`_render_event_message_content`(events.py, story #4088 2/2 코드 짝)가 이 kind 값으로
안내 문구를 유도한다(stage 이름 하드코딩 0, capability.kind 문자열 하나로만 분기).

②(마스터컷 evidence 앵커)·③(pending_approval 자동충족) 힌트는 기존 선언(live_generation.
capability.kind=="generate"·pending_approval.gate.type=="external_publish")에서 그대로
유도 — 이 마이그가 새로 건드릴 데이터가 없다(events.py 코드만).

Revision ID: 0389
Revises: 0388
Create Date: 2026-09-21

번호 조율(페드루 PO) — 1차(07:33Z) 0387은 디디군 #4090(1/2, 발행 축 임계 경로) 선점,
이 카드=0388. 2차(07:54Z) 디디군 #4090 ②③이 gate.publish_outcome 컬럼 마이그를
자체로 들고 와 ①②③ 한 PR로 묶여 0387+0388 두 자리를 다 쓰게 됨 — 이 카드는
0389(down 0388)로 한 번 더 밀림. 착지 순서: #4467(0386)→디디군 #4090(0387+0388)→
이 카드(0389)→#4083(0390).
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0389"
down_revision = "0388"
branch_labels = None
depends_on = None

_KEY = "preset.marketing.video_production"

_OLD_VERIFICATION = {"role": "Creator", "action": "프레임8+받아쓰기 등 눈·귀 검증 시트 작성"}
_NEW_VERIFICATION = {
    "role": "Creator", "action": "프레임8+받아쓰기 등 눈·귀 검증 시트 작성",
    "capability": {"kind": "attach_video"},
}
_OLD_EDITING = {"role": "Creator", "action": "편집 통일 패스(그레이드·룸톤·자막 레벨 통일)"}
_NEW_EDITING = {
    "role": "Creator", "action": "편집 통일 패스(그레이드·룸톤·자막 레벨 통일)",
    "capability": {"kind": "attach_video"},
}


def _patch_stage(bind, *, old_stage: dict, new_stage: dict, stage_key: str, version_delta: int) -> None:
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET stage_metadata = jsonb_set(stage_metadata, CAST(:path AS text[]), CAST(:new_stage AS jsonb)), "
            " version = version + :delta "
            "WHERE org_id IS NULL AND key = :key AND stage_metadata -> :stage_key = CAST(:old_stage AS jsonb)"
        ),
        {
            "path": "{" + stage_key + "}", "new_stage": json.dumps(new_stage),
            "delta": version_delta, "key": _KEY, "stage_key": stage_key, "old_stage": json.dumps(old_stage),
        },
    )


def upgrade() -> None:
    bind = op.get_bind()
    _patch_stage(bind, old_stage=_OLD_VERIFICATION, new_stage=_NEW_VERIFICATION, stage_key="verification", version_delta=1)
    _patch_stage(bind, old_stage=_OLD_EDITING, new_stage=_NEW_EDITING, stage_key="editing", version_delta=1)


def downgrade() -> None:
    bind = op.get_bind()
    _patch_stage(bind, old_stage=_NEW_VERIFICATION, new_stage=_OLD_VERIFICATION, stage_key="verification", version_delta=-1)
    _patch_stage(bind, old_stage=_NEW_EDITING, new_stage=_OLD_EDITING, stage_key="editing", version_delta=-1)
