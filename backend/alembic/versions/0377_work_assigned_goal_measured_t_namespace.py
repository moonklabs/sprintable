"""story #3893(E-UX-OVERHAUL·§⑤·Chat, PO 확定 2026-09-14) — 대화 이벤트 카드
`preset.work.assigned`·`preset.goal.measured` 잔존 2 preset을 0376과 같은 처방으로.

Revision ID: 0377
Revises: 0376
Create Date: 2026-09-14

[[no-pr-for-data]] 게이트 — 프리셋 표현 콘텐츠 변경(0166/0167/0240/0249/0375/0376 선례와
동일 규칙, 병합 전 선생님 확認 필요할 수 있음).

배경: story #3893은 최초 "block_template 자체가 없다"로 등재됐으나, 직접 DB 조회로
정정(미르코 그라운딩 2026-09-14) — 0249가 이미 두 preset의 block_template을 심어뒀고
그 이후 어떤 마이그도 건드리지 않았다(0376 docstring 52-54행이 이 두 preset을 명시
스코프 밖으로 남김, 실측 재확認). 실제 결함은 0376이 다른 두 preset에서 고친 것과
동일 클래스: 헤더·필드 라벨이 하드코딩 한국어(en 로케일에도 그대로 노출) + `preset.
work.assigned`는 `assignee_member_id`(raw UUID)를 `{{payload.assignee_member_id}}`로
그대로 노출(0376이 work_item_id에 한 처방과 동일 결함, 다른 필드) + 「이(가)
배정되었습니다」류 합니다체(PO 확定 — 서술형 문장 제거, `preset.work.status_changed`의
구조적 스타일 `type → 값`로 통일).

## AC1 처방 — 헤더·필드 라벨 t 네임스페이스 이관 (0376과 동일 패턴)
`preset.work.assigned`·`preset.goal.measured` 둘 다 하드코딩 헤더("작업 배정"/"목표
측정치 갱신")·필드 라벨("대상"/"담당자"/"목표"/"단위"/"출처")을 `{{t.X}}` 키로
이관한다(eventCard 네임스페이스, 유나 §⑤ 확定 2026-09-14 19:47Z 헤더 2건 — 「작업
배정」/"Assigned"·「목표 측정」/"Goal measured"). 나머지 필드 라벨("대상"·"목표"·
"단위"·"출처")은 기존 하드코딩 문구를 **그대로**(신규 어간 0, 낱말 발명 0) t 키로만
옮긴다 — 0376이 targetLabel/noteLabel/reasonLabel에 한 것과 동형.

## AC1 처방 — 담당자 참조 (PO 확定 — 「담당자=refs 멤버 이름 해석」)
`preset.work.assigned`의 「담당자」 field value를 `{{payload.assignee_member_id}}`
(raw UUID)에서 `{{label.assignee_name}}`으로 옮긴다. BE(events.py
`_render_event_notification_member_ref`, `_publish_registry_event_core`가
`assignee_member_id` 존재 시 항상 계산 — definition_key 무관, work_item ref와 동일
원칙)가 `refs["assignee"]`에 두 모양 中 하나를 싣는다(work_item의 3모양과 동형이되
"리졸버 자체가 없음" 갈래는 없음 — member는 항상 단일 리졸버):
  - 찾음: `{"found": True, "name": "표시 이름"}`
  - 못 찾음(탈퇴·삭제): `{"found": False}` — 텍스트는 FE가 렌더 시점 로케일로 짓는다
    (targetMissing과 동일 원칙, 새 t 키 `assigneeMissing` 1개 신설).

「대상」 필드(`{{payload.work_item_id}}` → `{{label.work_item_target}}`)는 별도 신규
BE 로직이 **불필요**하다 — `story_assignee_events.py`가 이미 `work_item_type`/
`work_item_id`를 payload에 함께 싣고 있어(0376이 만든 work_item ref 리졸버가
definition_key 무관 범용이라) 그 리졸버가 자동으로 적용된다(신규 발행 갈래 0, #2633
AC2 단일 파이프 유지).

## AC1 처방 — 본문 합니다체 제거 (PO 확定)
`preset.work.assigned` 본문을 "**{{payload.work_item_type}}** 이(가)
배정되었습니다."(서술형, en 무관 한국어 하드코딩)에서
"**{{label.work_item_type}}** → **{{label.assignee_name}}**"(구조적 화살표 스타일,
`preset.work.status_changed`의 "type `from` → `to`"와 동형, story #3888
`composeEventPreviewLine`이 이미 확定한 미리보기 포맷 "작업 배정 · {type} →
{담당자}"와도 동일 순서·구분자)로 교체한다.

`preset.goal.measured` 본문("측정치 **{{payload.metric_value}}**")은 이 마이그
스코프에서 **구조 변경 없음** — "측정치" 프리픽스만 `{{t.metricValueLabel}}`로
이관(기존 문구 그대로, 신규 어간 0).

## AC1 처방 — 배정자·측정 시각 (유나 확定 2026-09-14 20:16Z, PO 문의 즉시 회신)
`assigned_by_member_id`("배정자"/"Assigned by" — 담당자와 다른 낱말, 3역할
대상·담당자·배정자 구분)도 담당자와 동일 member-ref 리졸버로 이름 해석
(`refs["assigned_by"]` — `_render_event_notification_member_ref` 재사용, 새 로직
0)한다. `measured_at`("측정 시각"/"Measured at")은 FE `lib/i18n.ts::
formatLocaleDateTime`(기존 Intl 포매터)로 렌더 시점 로케일 포맷 — `{{label.
measured_at}}`(파싱 실패는 optional 생략, 새 리졸버 불요·payload 파생).

## CHANGES(PO PR#4298 리뷰 2026-09-15, 코드 그라운딩 정정 5건)
1. **metric_unit** — 실 값은 `completion_pct`(internal_ops epic 유일값)·GA4 소스는
   임의 문자열(org이 설정한 `metric_definition.metric`, 닫힌 집합 아님 — outcome_
   scorer.py 그라운딩 재확認). 「%」 리터럴 접미가 아니라 FE 기존 `outcomeLoop.
   metric_{slug}` 낱말(outcome-intent-fields.tsx가 이미 씀 — `metric_velocity`·
   `metric_backlog_remaining`·`metric_progress`·`metric_completion_pct`, 신규 어간
   0)을 재사용해 등재 metric만 라벨로 변환하고 미등재(GA4 임의값)는 단위 필드
   자체를 생략한다(optional elision) — `{{label.metric_unit_label}}`.
2. **goal_id**(raw UUID, 실은 epic.id) — `_render_event_notification_work_item_ref`
   에 "epic" 갈래 신설(`app.models.pm.Goal` 조회, SoftDeleteMixin 없어 deleted_at
   필터 없음) + `_publish_registry_event_core`가 `goal_id` 존재 시 `refs["goal"]`
   계산(work_item과 별도 트리거 — goal_id는 work_item_type/id 페어가 아님).
   FE `entity:epic` 참조 토큰 렌더는 이미 지원(embed-card.tsx RICH_PREVIEW_TYPES·
   getEntityHref 사전 확認 済 — 새 FE 렌더 경로 0) — `{{label.goal_target}}`.
3. **measured_at** — 위 AC1 처방 그대로(payload 파생, 새 리졸버 0).
4. **event-definition-summary(조직 이벤트 정의 페이지) 렌더 안전성** —
   `EventDefinitionSummary`가 `EventBlockCard`를 `refs` 없이(샘플 payload만) 호출한다
   (그라운딩 확認). 0376은 refs 의존 라벨(`work_item_target` 등)을 전부 **optional
   fields** 안에서만 참조해 refs 부재 시 그 필드 행이 조용히 생략됐다 — 0377의
   `preset.work.assigned` 초안이 `{{label.assignee_name}}`을 **비-optional text
   블록**(block-template.ts는 "fields"만 optional 생략을 지원, "text"는 없음)에
   직접 넣어 이 화면에서 `⟨missing: label.assignee_name⟩`이 새는 걸 실측으로 확認
   — 처방: text 블록은 `{{label.work_item_type}}`(payload 파생, refs 무관 — 항상
   안전) 단독으로 좁히고, 담당자는 optional fields 행에서만 참조한다(기존에도
   optional이었음, 위치만 text에서 fields-only로 정리).

## CHANGES 2차(PO PR#4298 재리뷰 2026-09-15 01:58Z) — 「출처」 raw slug 잔존
CHANGES①(metric_unit)과 같은 결함 클래스를 「출처」 필드에서 놓쳤다 — ko/en 카드 둘 다
"internal_ops" raw slug가 그대로 보였다(1차 캡처의 "raw slug 0 육안 확認"은 이 값을
«코드 낱말»로 못 알아본 판정 오류 — 자는 "렌더가 되는가"가 아니라 "사용자에게 코드
낱말이 보이는가"). outcome_scorer.py 그라운딩상 이 preset의 실 source 값은
"internal_ops"/"ga4" 둘뿐인 닫힌 집합 — hypotheses 네임스페이스의 기존
`sourceInternal`/`sourceGa4` 낱말(hypothesis-form.tsx 등 4개 소비처가 이미 씀, 신규
어간 0)을 재사용한다. 「출처」 field value를 `{{payload.source}}`에서
`{{label.source_label}}`(optional)로 교체 — 미등재 값은 metric_unit과 동일 원칙으로
필드 행 자체를 생략한다(지어내지 않는다).

org별 block_template 복제/자동 생성 메커니즘 0건(0375/0376 실측 재확認, 변화 없음).
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "0377"
down_revision = "0376"
branch_labels = None
depends_on = None

_TEMPLATES: dict[str, dict] = {
    "preset.work.assigned": {
        "blocks": [
            {"type": "header", "text": "{{t.workAssignedHeader}}"},
            {"type": "text", "text": "**{{label.work_item_type}}**"},
            {"type": "fields", "fields": [
                {"label": "{{t.targetLabel}}", "value": "{{label.work_item_target}}", "optional": True},
                {"label": "{{t.assigneeLabel}}", "value": "{{label.assignee_name}}", "optional": True},
                {"label": "{{t.assignedByLabel}}", "value": "{{label.assigned_by_name}}", "optional": True},
            ]},
        ],
    },
    "preset.goal.measured": {
        "blocks": [
            {"type": "header", "text": "{{t.goalMeasuredHeader}}"},
            {"type": "text", "text": "{{t.metricValueLabel}} **{{payload.metric_value}}**"},
            {"type": "fields", "fields": [
                {"label": "{{t.goalLabel}}", "value": "{{label.goal_target}}", "optional": True},
                {"label": "{{t.unitLabel}}", "value": "{{label.metric_unit_label}}", "optional": True},
                {"label": "{{t.sourceLabel}}", "value": "{{label.source_label}}", "optional": True},
                {"label": "{{t.measuredAtLabel}}", "value": "{{label.measured_at}}", "optional": True},
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
    # 이 마이그 적용 前 실측(직접 DB 쿼리, 2026-09-14) — 0249가 심은 뒤 이후 어떤 마이그도
    # 건드리지 않은 현재 상태 그대로 복원. 0249 원문 그대로가 아니다(metric_unit이 본문
    # 인라인에서 별도 optional 필드로 이동된 차이가 있음 — 어느 마이그가 그랬는지 추적
    # 못했으나, 실 DB 상태를 직접 쿼리해 복원값으로 쓰는 편이 재구성보다 정확하다).
    _ORIGINAL_0249: dict[str, dict] = {
        "preset.work.assigned": {
            "blocks": [
                {"type": "header", "text": "작업 배정"},
                {"type": "text", "text": "**{{payload.work_item_type}}** 이(가) 배정되었습니다."},
                {"type": "fields", "fields": [
                    {"label": "대상", "value": "{{payload.work_item_id}}"},
                    {"label": "담당자", "value": "{{payload.assignee_member_id}}"},
                ]},
            ],
        },
        "preset.goal.measured": {
            "blocks": [
                {"type": "header", "text": "목표 측정치 갱신"},
                {"type": "text", "text": "측정치 **{{payload.metric_value}}**"},
                {"type": "fields", "fields": [
                    {"label": "목표", "value": "{{payload.goal_id}}"},
                    {"label": "단위", "value": "{{payload.metric_unit}}", "optional": True},
                    {"label": "출처", "value": "{{payload.source}}"},
                ]},
            ],
        },
    }
    for key, template in _ORIGINAL_0249.items():
        bind.execute(
            sa.text(
                "UPDATE event_definitions SET block_template = :template "
                "WHERE org_id IS NULL AND key = :key"
            ),
            {"template": json.dumps(template), "key": key},
        )
