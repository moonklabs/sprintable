"""story #2181(모델↔DB drift 감사, 2026-07-24) — mockup_pages.viewport DEFAULT 신설.

Revision ID: 0209
Revises: 0208
Create Date: 2026-07-24

drift 감사(script/model_db_drift_audit.py) 발견 — 실 DB의 `viewport`는 이미 NOT NULL인데
모델은 `str | None`(선택)이라 선언돼 있었고, `CreateMockupRequest.viewport`도 optional(기본
None)이다. FE(mockups/page.tsx)는 항상 명시적으로 보내지만(자체 기본값 'desktop'), FE를
거치지 않는 다른 호출부(MCP·직접 API 호출)가 생략하면 `POST /mockups`가 실 DB에서
NotNullViolation → 500이었다(라이브 확認: viewport 생략 INSERT 재현).

DEFAULT 'desktop' — FE 자체 초기 상태값과 동일(mockups/page.tsx의 `useState<'desktop'|'mobile'>
('desktop')`)라 창작이 아니라 이미 존재하는 관례를 DB에도 반영하는 것. 백필 불요(기존 행은
전부 이미 NOT NULL 통과한 값이 있음, 컬럼 자체는 그대로 두고 DEFAULT만 추가하는 순수 확장).
"""
from __future__ import annotations

from alembic import op

revision = "0209"
down_revision = "0208"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE mockup_pages ALTER COLUMN viewport SET DEFAULT 'desktop'")


def downgrade() -> None:
    op.execute("ALTER TABLE mockup_pages ALTER COLUMN viewport DROP DEFAULT")
