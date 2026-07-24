"""전 런타임 올지원(story 6f6ac081) 까심 QA 후속 — role_templates.role_behaviors의 중복·거짓
"## 런타임 노트" 블록 제거.

Revision ID: 0163
Revises: 0161 (main variant — 원 develop 리비전은 0162 경유)
Create Date: 2026-07-08

미르코 라이브 확認(2026-07-08): grok/hermes 등 커넥터-라우팅 런타임 채용 산출물(AGENTS.md)에
"## 런타임 노트"가 두 번 등장 — compose_prompt의 section [E](agent_recruiter._runtime_notes,
#1959로 이미 런타임별 정직하게 분기됨)와, section [A](role_template.role_behaviors 그대로 삽입)
안에 0156/0157/0160이 하드코딩해 seed한 옛 문구("MCP 연결/스코프는 채용 시점 번들이 처리합니다")
가 중복 등장한다. 이 하드코딩은 런타임 무관 고정 텍스트라 커넥터 런타임엔 처음부터 거짓이었고,
이제 section [E]가 이 역할을 완전히 대체하므로(동적·런타임별 정확) role_behaviors 쪽 사본은
그냥 제거한다 — 정보 손실 없음(같은 정보가 [E]에 더 정확한 형태로 남음), 중복도 해소.

전 role_templates 행 대상(0156/0157/0160이 심은 catalog 전체가 이 정확히 동일한 tail 블록을
공유 — repo grep으로 3개 마이그 전부 byte-identical 확認). 정확한 substring REPLACE만 수행 —
role_behaviors의 나머지 내용(직무별 미션/도구/6번째 게이트 규칙)은 전혀 건드리지 않는다.

migrate-prod-preflight CI 정정(2026-07-08, 이 승격 브랜치 한정): 애초 계획은 0162의
down_revision만 단일 reparent였으나, `Main Alembic preflight`의 "Assert main migration file
set" 스텝이 **0162 파일 자체의 부재**를 요구한다는 걸 실 CI 실행에서 발견(로컬 시뮬레이션이
이 스텝을 재현하지 못해 놓쳤던 부분) — 0146/0147(ee_pricing)이 main에 아예 없으니 그 둘을
단일head로 합치는 merge-node(0162) 자체가 main 위에선 의미가 없다(합칠 대상이 없음).
그래서 0162 파일을 이 브랜치에서 삭제하고, 0163이 0161을 직접 가리키도록 재조정한다 — 0148이
0147 대신 0145를 직접 가리키게 한 story bda4beac와 동일 패턴. develop 자체의 0162/0163은
무변경(ee_pricing이 develop 위에선 유효 브랜치).
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0163"
down_revision = "0161"
branch_labels = None
depends_on = None

_STALE_BLOCK = (
    "\n\n## 런타임 노트\n"
    "이 지침은 런타임(claude-code 등)에 관계없이 동일합니다. "
    "MCP 연결/스코프는 채용 시점 번들이 처리합니다.\n"
)


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE role_templates "
            "SET role_behaviors = REPLACE(role_behaviors, :stale, '') "
            "WHERE role_behaviors LIKE '%' || :stale || '%'"
        ).bindparams(sa.bindparam("stale", value=_STALE_BLOCK, type_=sa.Text))
    )


def downgrade() -> None:
    # 원문 복원(re-append) — 0156/0157/0160 seed 당시 이 블록은 항상 role_behaviors의 마지막
    # 내용이었다(repo 확認). 이미 tail에서 제거된 행에만 다시 붙인다(멱등 — 중복 재부착 방지).
    op.execute(
        sa.text(
            "UPDATE role_templates "
            "SET role_behaviors = role_behaviors || :stale "
            "WHERE role_behaviors NOT LIKE '%' || :stale || '%'"
        ).bindparams(sa.bindparam("stale", value=_STALE_BLOCK, type_=sa.Text))
    )
