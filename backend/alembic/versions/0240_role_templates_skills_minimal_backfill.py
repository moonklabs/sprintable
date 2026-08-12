"""E-AGENT-ONBOARD·A2A발견 P1(story #2599, 문서 e-a2a-discovery-spike-design 갭 D):
role_templates.skills 최소 백필 — qa-automation + 원 builtin 3종(backend/frontend/pm).

Revision ID: 0240
Revises: 0239
Create Date: 2026-08-12

[[no-pr-for-data]] 게이트: 이 마이그는 role_templates.skills(app.schemas.a2a.AgentSkill 형태,
0161이 "A2A 발견 키"로 도입)에 실 콘텐츠를 채운다 — 데이터 마이그레이션이라 병합 前 선생님
명시 승인 필요(0166/0167 선례와 동일 규칙).

배경(#2584 스파이크 갭 D): skills 컬럼은 0161 도입 이래 전 24개 seed 카탈로그가 `[]`째
방치돼 있었다 — `_build_agent_card`(app/routers/a2a.py:366)가 매번 persona.slug/name 파생
단일 skill로 폴백해, 오늘 모든 AgentCard의 skill이 예외 없이 1개짜리였다. 찰스 시나리오
(#2584)가 `?skill=qa`로 QA 적임자를 발견하려면 최소한 qa-automation 카드에 구조화 skill이
있어야 한다 — 원 builtin 3종(backend/frontend/pm, 0156)도 같은 이유로 최소 백필한다(이
팀의 실 채용 role과 가장 가까운 4종). 전체 24 카탈로그 백필은 스코프 밖(별도 스토리, ~300직군
트랙 연계) — 여기서는 "발견 신호가 이름 문자열 하나뿐"이라는 갭만 최소로 해소한다.

콘텐츠는 새로 짓지 않고 0156이 이미 seed한 role_templates.description을 AgentSkill(id/name/
description/tags) shape로 재구성만 한다(신규 주장 0건 — 기존 승인된 카탈로그 문구 재사용).
tags는 `_skill_matches`(a2a.py:459, name/description/tags substring)가 `?skill=` 매칭에
쓰는 실 검색어 — 각 role의 실사용 관례 키워드로 채운다.
"""
from __future__ import annotations

import json

from alembic import op
import sqlalchemy as sa

revision = "0240"
down_revision = "0239"
branch_labels = None
depends_on = None

_SKILLS: dict[str, list[dict]] = {
    "qa-automation": [
        {
            "id": "qa-automation",
            "name": "QA Automation Engineer",
            "description": "테스트 자동화 구축과 회귀 방지를 자율적으로 운영하는 QA 자동화 엔지니어.",
            "tags": ["qa", "testing", "test-automation", "regression", "quality-assurance"],
        }
    ],
    "backend": [
        {
            "id": "backend",
            "name": "Backend Engineer",
            "description": "API·데이터 모델·서버 로직 구현을 자율적으로 운영하는 백엔드 엔지니어.",
            "tags": ["backend", "api", "database", "server"],
        }
    ],
    "frontend": [
        {
            "id": "frontend",
            "name": "Frontend Engineer",
            "description": "UI/UX 구현과 프론트엔드 버그 수정을 자율적으로 운영하는 프론트엔드 엔지니어.",
            "tags": ["frontend", "ui", "ux", "react"],
        }
    ],
    "pm": [
        {
            "id": "pm",
            "name": "Product Manager",
            "description": "스토리/에픽 기획과 스프린트·가설 운영을 자율적으로 운영하는 PM/PO.",
            "tags": ["pm", "product", "planning", "roadmap"],
        }
    ],
}


def upgrade() -> None:
    bind = op.get_bind()
    for slug, skills in _SKILLS.items():
        bind.execute(
            sa.text("UPDATE role_templates SET skills = :skills WHERE slug = :slug"),
            {"skills": json.dumps(skills), "slug": slug},
        )


def downgrade() -> None:
    bind = op.get_bind()
    for slug in _SKILLS:
        bind.execute(
            sa.text("UPDATE role_templates SET skills = '[]'::jsonb WHERE slug = :slug"),
            {"slug": slug},
        )
