"""story #2004(E-A2A-PROTO Phase B P1-b) — A2A SendMessage 멱등키: `a2a_tasks.client_message_id`.

클라이언트가 `Message.message_id`(A2A 스펙 REQUIRED 필드, 임의 문자열)로 재시도(네트워크
타임아웃·수동 재발송)했을 때 동일 `(member_id, client_message_id)` 쌍을 재사용해 중복
Task/중복 CC 위임을 막기 위한 dedup 키. 방어선 1은 `_handle_send_message`의
`pg_advisory_xact_lock`(체크-then-액트 TOCTOU를 구조적으로 막음, [[feedback_check_then_insert_toctou]]
교훈) — 이 UNIQUE 인덱스는 방어선 2(락 우회 경로가 생기더라도 DB 레벨에서 최종 봉인).

partial UNIQUE 인덱스(`WHERE client_message_id IS NOT NULL`)를 명시적으로 선택 — plain
UNIQUE 제약도 Postgres가 다중 NULL을 서로 distinct로 취급해 기존/레거시 행(컬럼 없던 시절
생성된 row, NULL)들끼리 충돌하지 않지만, 그 동작이 "우연히 안전"이 아니라 "의도"임을 DDL
자체가 읽는 사람에게 명시하도록 partial 형태를 택했다(story 지시 — 두 방식 다 허용, 명시성
우선).

Revision ID: 0201
Revises: 0200
Create Date: 2026-07-18
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0201"
down_revision = "0200"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("a2a_tasks", sa.Column("client_message_id", sa.Text(), nullable=True))
    op.create_index(
        "uq_a2a_tasks_member_client_message_id",
        "a2a_tasks",
        ["member_id", "client_message_id"],
        unique=True,
        postgresql_where=sa.text("client_message_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_a2a_tasks_member_client_message_id", table_name="a2a_tasks")
    op.drop_column("a2a_tasks", "client_message_id")
