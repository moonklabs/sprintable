"""story 037a8aa8 ②(에이전트 발견성 3층 fix — 유나 디자인 권위+PO GREEN 확定 문구) —
ui-designer/design-system/frontend role_behaviors에 "캔버스 저작" 섹션 추가 + ui-designer
구 "목업" 문장 정밀화.

Revision ID: 0183
Revises: 0182
Create Date: 2026-07-14

78f07614 그라운딩②: 24개 role_template 전체에서 캔버스/artifact 언급이 0건이었다(①에서 canvas
그룹을 새로 받은 ui-designer/design-system 포함) — 툴 접근권과 사용판단이 완전히 분리된 상태.
문구는 유나(디자인 권위)+PO가 확定해 전달한 것을 verbatim 반영(재작성 금지). REPLACE 앵커
("\\n\\n## 막히면 스스로 확인하세요")는 3개 role 전부 byte-identical 확인(0163과 동일 안전성
근거) — "## 스스로 판단해 운영하는 법" 목록 직후·"## 막히면..." 직전에 새 섹션 삽입.
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0183"
down_revision = "0182"
branch_labels = None
depends_on = None

_ANCHOR = "\n\n## 막히면 스스로 확인하세요"

_BASE = (
    "UI·화면·컴포넌트·다이어그램 등 시각 산출물을 만들거나 설계 의도를 공유할 때는 텍스트 설명으로"
    " 대신하지 말고 캔버스(create_artifact)로 구조화해 그립니다. 각 요소의 스펙은 핀과 설명"
    "(description)으로 명시해 핸드오프 계약이 되게 하고(빈 설명 금지), 사람은 캔버스에서 실물을"
    " 보며 코멘트·핀으로 피드백하고 그 피드백은 edit_artifact로 반영합니다(수정은 새 버전이 되어"
    " 변천사가 남습니다)."
)

_ROLE_SPECIFIC = {
    "ui-designer": (
        "시안·목업·디자인 스펙의 1차 산출 형태가 캔버스입니다. 계약 문서(doc)를 SSOT로 유지하되"
        " 시각은 해당 스토리의 visual_artifact로 붙여 발견·핸드오프되게 합니다."
    ),
    "design-system": (
        "디자인 토큰·컴포넌트 규격·준수 예시를 텍스트 나열 대신 캔버스로 시각화하고, 규격 이탈은"
        " 핀으로 지적합니다."
    ),
    "frontend": (
        "구현 전 참조 시안을 캔버스에서 열람하고, UI 질문·구현 결과를 캔버스로 공유해 디자이너와"
        " 핀·코멘트로 왕복합니다(구현자도 캔버스 소비자·도그푸딩)."
    ),
}

_UI_DESIGNER_OLD_MOCKUP_SENTENCE = (
    "6. 디자인 변경은 실제 화면에서 렌더링을 확인한 뒤에만 완료로 표시하세요"
    "(목업만으론 충분하지 않습니다)."
)
_UI_DESIGNER_NEW_MOCKUP_SENTENCE = (
    "6. 디자인 변경의 done-gate는 배포 후 라이브 렌더·실사용 확인입니다. 정적 시안이나 캔버스"
    " 목업이 완성돼도 실렌더에서 검증되기 전엔 잠정이며, 완료로 보고하지 않습니다."
)


def _canvas_section(slug: str) -> str:
    return f"\n\n## 캔버스 저작\n{_BASE}\n{_ROLE_SPECIFIC[slug]}"


def upgrade() -> None:
    conn = op.get_bind()
    for slug in ("ui-designer", "design-system", "frontend"):
        conn.execute(
            sa.text(
                "UPDATE role_templates SET role_behaviors = REPLACE(role_behaviors, :anchor, :replacement) "
                "WHERE slug = :slug AND role_behaviors LIKE '%' || :anchor || '%'"
            ),
            {"anchor": _ANCHOR, "replacement": _canvas_section(slug) + _ANCHOR, "slug": slug},
        )
    conn.execute(
        sa.text(
            "UPDATE role_templates SET role_behaviors = REPLACE(role_behaviors, :old, :new) "
            "WHERE slug = 'ui-designer' AND role_behaviors LIKE '%' || :old || '%'"
        ),
        {"old": _UI_DESIGNER_OLD_MOCKUP_SENTENCE, "new": _UI_DESIGNER_NEW_MOCKUP_SENTENCE},
    )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(
        sa.text(
            "UPDATE role_templates SET role_behaviors = REPLACE(role_behaviors, :new, :old) "
            "WHERE slug = 'ui-designer' AND role_behaviors LIKE '%' || :new || '%'"
        ),
        {"old": _UI_DESIGNER_OLD_MOCKUP_SENTENCE, "new": _UI_DESIGNER_NEW_MOCKUP_SENTENCE},
    )
    for slug in ("ui-designer", "design-system", "frontend"):
        conn.execute(
            sa.text(
                "UPDATE role_templates SET role_behaviors = REPLACE(role_behaviors, :replacement, :anchor) "
                "WHERE slug = :slug AND role_behaviors LIKE '%' || :replacement || '%'"
            ),
            {"anchor": _ANCHOR, "replacement": _canvas_section(slug) + _ANCHOR, "slug": slug},
        )
