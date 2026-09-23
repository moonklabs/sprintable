"""story #4188(E-RECIPE-2·문구) — 영상 제작 프리셋의 사용자 노출 문구에서 내부어를 걷어낸다.

플랫폼 프리셋(org_id NULL)이라 모든 조직의 레시피 갤러리 카드·상세·단계 목록·채팅 이벤트
카드에 그대로 뜬다. 0381이 남긴 «BYOA·레시피 1호·딸깍·전이·실탄·발사·표적·i2v·VO·확定»을
유나 확정 문안(2026-09-23, 스토리 본문)으로 교체한다 — name은 그대로.

- description, stage_metadata[*].action(9단계), block_template 머리말(레시피 → 워크플로우)만
  UPDATE. stage slug·role·gate·capability·routing은 무변 — 적용된 프로젝트의 역할 바인딩·진행
  상태에 영향 0(0385와 같은 근거: 그 경로들은 이 문자열 값을 읽지 않는다).
- 같은 가드가 잡은 preset.workflow.kanban 설명(«상태 전이 기반…», 설정 템플릿 갤러리·루프 생성 미리보기에
  노출)도 여기서 함께 고친다(PO 판단 — 가드 예외 줄 대신 문구 수정).
- 재발 방지는 tests/test_4188_platform_preset_user_copy_guard_realdb.py(플랫폼 프리셋 전체).

Revision ID: 0395
Revises: 0394
Create Date: 2026-09-23
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0395"
down_revision = "0394"
branch_labels = None
depends_on = None

_KEY = "preset.marketing.video_production"

_OLD_DESCRIPTION = (
    "BYOA 영상 제작 레시피 1호 — 소재 수집부터 발행까지 9단계, 사람 게이트 4곳"
    "(컨셉·구조·실탄예산·최종발행)만 사람이 딸깍하고 나머지 전이는 에이전트가 진행."
)
_NEW_DESCRIPTION = (
    "소재 수집부터 발행까지 9단계예요. 컨셉·구조·생성 예산·최종 발행 네 곳만 사람이 승인하고, "
    "나머지는 에이전트가 진행해요."
)

# stage -> (old action, new action). 옛 값은 dev 실값(0381 시드 이후 무변경)과 대조 확認.
_ACTIONS: dict[str, tuple[str, str]] = {
    "draft": ("로그라인·매핑표·컨셉 초안 작성", "로그라인·컨셉 초안 작성"),
    "concept_confirmed": (
        "우화 비트↔제품 가치 매핑 + 미션 정합 확定 승인",
        "컨셉 승인(이야기와 제품 가치가 맞는지 확인)",
    ),
    "animatic": (
        "무과금 스틸+텍스트+VO 애니매틱 제작 후 구조 판정 요청",
        "애니매틱 제작(무료 스틸·자막·내레이션) 후 구조 검토 요청",
    ),
    "structure_passed": (
        "구조 판정 통과 확인 + 표적·예산 명시해 실탄 발사 승인",
        "구조 확인 후 생성 대상과 예산을 정해 유료 생성 승인",
    ),
    "live_generation": (
        "실탄(유료 생성) 모델(키컷·i2v·음성·립싱크) 호출",
        "유료 생성 실행(키 컷·영상·음성·립싱크)",
    ),
    "verification": (
        "프레임8+받아쓰기 등 눈·귀 검증 시트 작성",
        "검증 시트 작성(프레임·자막 받아쓰기로 화면과 소리 확인)",
    ),
    "editing": (
        "편집 통일 패스(그레이드·룸톤·자막 레벨 통일)",
        "편집 마무리(색·배경음·자막 크기 맞추기)",
    ),
    "published": ("승인된 채널에 실 게시", "승인된 채널에 게시"),
}

_OLD_HEADER = "영상 제작 레시피"
_NEW_HEADER = "영상 제작 워크플로우"

# 같은 가드가 잡은 같은 부류(PO 판단 2026-09-23) — 설정 템플릿 갤러리·루프 생성 미리보기에 뜨는 설명.
_KANBAN_KEY = "preset.workflow.kanban"
_KANBAN_OLD_DESCRIPTION = "상태 전이 기반 알림. 역할 구분 없이 상태 변경 시 팀 알림."
_KANBAN_NEW_DESCRIPTION = "상태가 바뀔 때마다 팀에 알림. 역할을 나누지 않는 팀에 적합."


def _block_template(header: str) -> str:
    return json.dumps({
        "blocks": [
            {"type": "header", "text": header},
            {"type": "text", "text": "**{{label.stage}}** 단계로 넘어갔습니다"},
            {"type": "fields", "fields": [
                {"label": "대상", "value": "{{label.work_item_target}}"},
            ]},
        ],
    })


def _apply(description: str, actions: dict[str, str], header: str, version_delta: int) -> None:
    bind = op.get_bind()
    for stage, action in actions.items():
        bind.execute(
            sa.text(
                "UPDATE event_definitions "
                "SET stage_metadata = jsonb_set(stage_metadata, ARRAY[:stage, 'action'], to_jsonb(CAST(:action AS text))) "
                "WHERE org_id IS NULL AND key = :key AND stage_metadata ? :stage"
            ),
            {"stage": stage, "action": action, "key": _KEY},
        )
    bind.execute(
        sa.text(
            "UPDATE event_definitions "
            "SET description = :description, block_template = CAST(:block_template AS jsonb), "
            "version = version + :delta "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {"description": description, "block_template": _block_template(header), "delta": version_delta, "key": _KEY},
    )


def _set_kanban_description(description: str, version_delta: int) -> None:
    op.get_bind().execute(
        sa.text(
            "UPDATE event_definitions SET description = :description, version = version + :delta "
            "WHERE org_id IS NULL AND key = :key"
        ),
        {"description": description, "delta": version_delta, "key": _KANBAN_KEY},
    )


def upgrade() -> None:
    _apply(_NEW_DESCRIPTION, {s: new for s, (_, new) in _ACTIONS.items()}, _NEW_HEADER, 1)
    _set_kanban_description(_KANBAN_NEW_DESCRIPTION, 1)


def downgrade() -> None:
    _set_kanban_description(_KANBAN_OLD_DESCRIPTION, -1)
    _apply(_OLD_DESCRIPTION, {s: old for s, (old, _) in _ACTIONS.items()}, _OLD_HEADER, -1)
