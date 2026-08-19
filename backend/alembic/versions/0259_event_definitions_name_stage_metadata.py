"""story #2792(2790 P1) — event_definitions에 name/description/stage_metadata 신설.

PO 확定(2026-08-19):
- name(NOT NULL)·description(nullable) — 사람용 표시(드롭다운 등). key는 기계용 식별자로
  그대로 둔다(role_templates류 i18n 오버레이는 신설 안 함, 이번 스코프 밖).
- stage_metadata(NOT NULL, 기본 '{}') — 사이클형 정의의 stage별 {role, action} 카탈로그
  메타. "기대 행동은 정의 레벨 데이터"(발행 payload 아님) 판별의 실물. 키 집합은
  event_definition_registry.validate_stage_metadata가 등록/수정 시점에 stage.enum의
  부분집합인지 강제(가드①) — 이 마이그는 컬럼만 추가, 기존 행 검증은 0260(컴파일)이
  스스로 유효한 값만 넣으므로 여기선 백필 후 재검증 불요.

name은 NOT NULL이라 기존 행(0245 프리셋 4종 + 있을 수 있는 org 커스텀) 백필이 필요 —
`key`를 폴백으로 채운 뒤 NOT NULL로 잠근다(값이 없는 것보다 key라도 있는 게 안전, 프리셋
4종은 이 마이그가 곧바로 사람이 읽을 이름으로 덮어쓴다).

⛔실버그(카디르군 QA, 2026-08-19) — 백필 WHERE절을 `name IS NULL`로 짰으나 **0행만 잡힌다**.
`ADD COLUMN ... server_default=''`는 PG11+ fast-default라 실 UPDATE 없이 기존 행에 즉시
"missing value"로 `''`를 채운다(디스크 재기록 없음) — 그래서 기존 행은 물리적으로 NULL이
아니라 **논리적으로 이미 `''`를 읽는다**. `WHERE name IS NULL`은 그 어떤 기존 행도 못 잡고,
프리셋 4종은 사람이 읽을 이름 대신 `''`로 영구 고정될 뻔했다(PO AC도 이 WHERE절을 못
잡았던 구멍 — 페드루 확認). 백필 조건을 실제 상태(`name = ''`)로 정정.

Revision ID: 0259
Revises: 0258
Create Date: 2026-08-19
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0259"
down_revision = "0258"
branch_labels = None
depends_on = None

# 0245 시드 4종의 사람용 이름 — key로 매칭해 백필(그 외 org 커스텀 행은 key 폴백).
_PRESET_NAMES: dict[str, str] = {
    "preset.gate.verdict": "게이트 판정",
    "preset.work.status_changed": "작업 상태 변경",
    "preset.work.assigned": "작업 배정",
    "preset.goal.measured": "목표 측정",
}


def upgrade() -> None:
    # server_default='' — model.py와 동일 컨벤션(진짜 데이터 경로용이 아니라 create_all+구
    # 시드 리터럴 직삽입 같은 레거시 경로의 안전망, enabled/version/stage_metadata와 동형).
    op.add_column(
        "event_definitions", sa.Column("name", sa.Text(), nullable=True, server_default="")
    )
    op.add_column("event_definitions", sa.Column("description", sa.Text(), nullable=True))
    op.add_column(
        "event_definitions",
        sa.Column("stage_metadata", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
    )

    conn = op.get_bind()
    for key, name in _PRESET_NAMES.items():
        conn.execute(
            sa.text("UPDATE event_definitions SET name = :name WHERE key = :key AND name = ''"),
            {"name": name, "key": key},
        )
    # 그 외(있을 수 있는 org 커스텀 행) — key를 폴백 이름으로.
    conn.execute(sa.text("UPDATE event_definitions SET name = key WHERE name = ''"))

    op.alter_column("event_definitions", "name", nullable=False)


def downgrade() -> None:
    op.drop_column("event_definitions", "stage_metadata")
    op.drop_column("event_definitions", "description")
    op.drop_column("event_definitions", "name")
