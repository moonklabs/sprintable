"""story #3884(E-UX-OVERHAUL·§⑤·Chat·customer-zero) — 대화 이벤트 카드 「대상」 원시 UUID →
제목 참조 토큰(클릭 이동) + preset 고정 문구(헤더·필드 라벨·접속어) ko/en 한 벌.

Revision ID: 0376
Revises: 0375
Create Date: 2026-09-14

[[no-pr-for-data]] 게이트 — 프리셋 표현 콘텐츠 변경(0166/0167/0240/0249/0375 선례와 동일
규칙, 병합 전 선생님 확認 필요할 수 있음).

배경: PO 3881 캡처 리뷰 적기(2026-09-14 15:26Z)+디디 적기(15:33Z) → PO develop 33f0ce199
재측(2026-09-14 15:52Z): `preset.work.status_changed`·`preset.gate.verdict`의 「대상」
field value가 `{{payload.work_item_id}}` 원시 UUID 그대로(3881 AC5 캡처 artifact
cbbb8a8f에 「대상 00000000-0000-0000-0000-000000000001」로 실측). 또한 헤더(「작업 상태
변경」·「게이트 판정」)·필드 라벨(「대상」·「메모」·「사유」)·본문 접속어(「게이트 —」)가
전부 이 마이그에 한국어로 baked — en 로케일 사용자도 고정 문구가 한글이었다(원시 slug와
같은 "발행 시점 고정" 결함 클래스, story #3881과 동일 처방 원칙 재사용).

## AC1 처방 — 대상 참조 토큰화 (PO 확定 2026-09-14 15:52Z)
「대상」 field value를 `{{payload.work_item_id}}`에서 `{{label.work_item_target}}`으로
옮긴다(새 `{{ref.X}}` 직접 참조가 아니라 `label` 경유 — 아래 이유). BE(events.py
`_render_event_notification_work_item_ref`)가 이제 `refs["work_item"]`에 세 모양 中
하나를 싣는다:
  - 찾음: `{"found": True, "token": "[제목](entity:type:id)"}`
  - 리졸버는 있는데(story/task/doc/visual_artifact) 이 id가 없음(삭제·조직 밖):
    `{"found": False, "type": work_item_type}` — **텍스트를 여기서 굽지 않는다**(로케일에
    달린 문구, FE가 렌더 시점에 `t('eventCard.targetMissing', {type})`로 짓는다).
  - 리졸버 자체가 없는 타입(agent_decision·support_escalation — 참조할 «엔티티» 개념이
    구조적으로 없음, gate 자체도 TARGET_ONLY #2889 그대로): refs에 키 자체가 없음.
FE(event-block-card.tsx)가 이 세 모양을 `labels['work_item_target']`(찾음=토큰 문자열
그대로 재사용 → 기존 참조 토큰 렌더 메커니즘, 3332가 이미 지원 → 새 메커니즘 0 / 못
찾음=targetMissing 문구 / 리졸버 없음=labels 키 자체 미설정)으로 미리 계산해 넘긴다 —
`optional: true`가 "리졸버 없음"일 때만 그 field entry 자체를 줄 생략시킨다(block-
template.ts의 기존 elision 메커니즘, story #3881, 새 기전 0).

## AC2 처방 — 헤더·필드 라벨·접속어 ko/en 한 벌 (PO 확定 2026-09-14 15:52Z·16:03Z)
4번째 mustache 네임스페이스 `{{t.X}}`(block-template.ts, label 패턴의 확장) 신설. 이
마이그는 헤더·필드 라벨·접속어 자리에 **키 이름**만 심고(payload와 무관한 고정 UI
카피라 `label`과 구분), EventBlockCard가 `useTranslations('eventCard')`(유나 §⑤ 낱말
표·doc a699be00 확定 7키, 2026-09-14 16:02Z)로 렌더 시점에 해석한다. 알 수 없는 t 키는
`⟨missing: t.X⟩` fail-loud(payload/ref/label과 동형 계약).

`preset.gate.verdict`의 본문 접속어는 통째로 `{{label.gate_connective_line}}` 1토큰으로
바뀐다(PO 구조 결정 — 리터럴 「게이트」 제거: 미등재 gate_type이 `gateTypeLabel`의
`ccGateGeneric` 폴백(ko 「게이트」)으로 떨어지면 구 템플릿("**{{label.gate_type}}** 게이트
— …")이 「게이트 게이트 — …」로 이중 인쇄되는 잠재 결함이 있었다 — `gateVerdictHeader`
(「게이트 판정」)가 이미 게이트 맥락을 운반하므로 본문 중복 제거. EventBlockCard가
`t('eventCard.gateConnective', {gateType, verdict})`로 미리 조립해 `labels.
gate_connective_line`에 싣는다 — next-intl ICU 단일 중괄호 보간과 이 파일의 이중 중괄호
mustache는 서로 다른 계층이라 충돌 0).

`preset.work.assigned`(assignee_member_id raw UUID 노출)·`preset.goal.measured`(고정
문구 4곳·「목표」·「단위」·「출처」·헤더)는 이번 스코프 밖(유나 §⑤ 낱말 표가 이 두 프리셋
(status_changed·gate.verdict) 7키만 확定 — PR 본문에 그대로 적기, 새 착수 0).

org별 block_template 복제/자동 생성 메커니즘 0건(0375 실측 재확認, 변화 없음) — org override
존재 여부는 런타임 데이터라 이 마이그 범위 밖(PO 판단 후속 여지, 0375와 동일 관찰).
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0376"
down_revision = "0375"
branch_labels = None
depends_on = None

_TEMPLATES: dict[str, dict] = {
    "preset.work.status_changed": {
        "blocks": [
            {"type": "header", "text": "{{t.statusChangedHeader}}"},
            {"type": "text", "text": "**{{label.work_item_type}}** `{{label.from_status}}` → `{{label.to_status}}`"},
            {"type": "fields", "fields": [
                {"label": "{{t.targetLabel}}", "value": "{{label.work_item_target}}", "optional": True},
                {"label": "{{t.noteLabel}}", "value": "{{payload.note}}", "optional": True},
            ]},
        ],
    },
    "preset.gate.verdict": {
        "blocks": [
            {"type": "header", "text": "{{t.gateVerdictHeader}}"},
            {"type": "text", "text": "{{label.gate_connective_line}}"},
            {"type": "fields", "fields": [
                {"label": "{{t.targetLabel}}", "value": "{{label.work_item_target}}", "optional": True},
                {"label": "{{t.reasonLabel}}", "value": "{{payload.resolution_note}}", "optional": True},
            ]},
        ],
    },
}


def upgrade() -> None:
    bind = op.get_bind()
    for key, template in _TEMPLATES.items():
        bind.execute(
            sa.text(
                "UPDATE event_definitions SET block_template = :template "
                "WHERE org_id IS NULL AND key = :key"
            ),
            {"template": json.dumps(template), "key": key},
        )


def downgrade() -> None:
    bind = op.get_bind()
    # 0375가 심은 상태 그대로 복원(이 마이그 적용 前 상태) — preset.goal.measured/
    # preset.work.assigned은 이 마이그가 건드리지 않았으므로 재수록 불요.
    _ORIGINAL_0375: dict[str, dict] = {
        "preset.work.status_changed": {
            "blocks": [
                {"type": "header", "text": "작업 상태 변경"},
                {"type": "text", "text": "**{{label.work_item_type}}** `{{label.from_status}}` → `{{label.to_status}}`"},
                {"type": "fields", "fields": [
                    {"label": "대상", "value": "{{payload.work_item_id}}"},
                    {"label": "메모", "value": "{{payload.note}}", "optional": True},
                ]},
            ],
        },
        "preset.gate.verdict": {
            "blocks": [
                {"type": "header", "text": "게이트 판정"},
                {"type": "text", "text": "**{{label.gate_type}}** 게이트 — **{{label.verdict}}**"},
                {"type": "fields", "fields": [
                    {"label": "대상", "value": "{{payload.work_item_id}}"},
                    {"label": "사유", "value": "{{payload.resolution_note}}", "optional": True},
                ]},
            ],
        },
    }
    for key, template in _ORIGINAL_0375.items():
        bind.execute(
            sa.text(
                "UPDATE event_definitions SET block_template = :template "
                "WHERE org_id IS NULL AND key = :key"
            ),
            {"template": json.dumps(template), "key": key},
        )
