"""story #3474(Phase1·마케팅운영, 페드루 PO 確定 2026-09-05) — `publication_attempts`
원장. 블루프린트 v3 §1 구조적 차단 장치 4 「유효한 휴먼 승인 레코드가 없으면 외부
어댑터 호출 자체를 거부」가 지금은 "커맨드 존재=승인"이라는 암묵 계약으로만 서
있었다(디디 그라운딩 2026-09-05 — create_or_get_publication_command()가 승인
분기 안에서만 호출되는 게 유일한 보장, 워커는 이후 gate.status를 재확인 안 함).
이 원장은 워커가 adapter 호출 "직전" 게이트를 재조회한 결과(approval_check)와
실제로 adapter를 호출했는지(adapter_called)를 매 시도마다 남겨 「승인 없는 호출
0건」을 쿼리 한 줄로 셀 수 있게 한다.

FK 없음(publication_commands·channel_connections와 동일 관례, 그라운딩 §9).

down_revision=0326는 story #3471(#3825, org_content_rules) — 이 스토리 착수
시점에 develop 미착지였다(gh pr list로 실물 확인, 열린 PR의 alembic/versions
까지가 SSOT)."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0327"
down_revision = "0326"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "publication_attempts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("command_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("gate_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        # 'ok'|'missing'|'voided'|'version_mismatch' — CHECK 없는 Text(이 도메인
        # 전체 관례, publication_commands.status와 동형 — 값 추가 시 마이그 불요).
        sa.Column("approval_check", sa.Text(), nullable=False),
        sa.Column("adapter_called", sa.Boolean(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("result_code", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("publication_attempts")
