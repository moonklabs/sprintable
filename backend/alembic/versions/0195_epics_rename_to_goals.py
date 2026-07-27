"""계층 리네이밍 B1(story 1925): epics 테이블을 goals로 rename.

선생님 확定(2026-07-16): 계층 리네이밍 전면(DB/클래스+REST 경로+MCP tool+JSON 필드)+구 이름 별칭
무중단 서빙. 0088 선례(`ALTER TABLE team_members RENAME TO team_members_legacy`)와 동일하게
순수 `RENAME TO`만 사용 — 인덱스/제약명(`epics_pkey`·`idx_epics_org_id`·`idx_epics_project_id`·
`epics_priority_check`·`epics_status_check`·`fk_epics_source_loop_id_loop_runs`)은 그대로
`epics_*` 유지(기능 영향 0, Postgres FK/인덱스는 테이블 OID 참조라 rename 후에도 안 끊김).

FK 컬럼명(stories.epic_id·policy_documents.epic_id·hypothesis_epic_links.epic_id)은 이번
스코프 밖(B4 후속) — FK 타겟 테이블만 goals로 갱신(모델 레벨에서 이미 반영, DDL 자체는 FK
제약이 OID 참조라 컬럼명 변경 불요).

Revision ID: 0195
Revises: 0194
Create Date: 2026-07-16
"""
from __future__ import annotations

from alembic import op

revision = "0195"
down_revision = "0194"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE epics RENAME TO goals")


def downgrade() -> None:
    op.execute("ALTER TABLE goals RENAME TO epics")
