"""E-POLISH 53bc0945: release_notes 테이블 — 하드코딩 RELEASE_NOTES de-hardcode + 시드.

릴노트 제품 전역(org 무관) 글로벌 테이블. note_key = FE localStorage seen-key("2026-06-v1-4")·무회귀.
시드 = 기존 v1.2~v1.4(release-notes.ts const 무손실 이관) + v1.5 스토리지 노트(파일첨부·썸네일) 추가.

idempotent: 테이블 inspect 가드(시드는 create 직후만). downgrade = drop.
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "0142"
down_revision = "0141"
branch_labels = None
depends_on = None


_SEED = [
    {
        "note_key": "2026-05-v1-2", "version": "v1.2",
        "published_at": "2026-05-15 00:00:00+00", "display_period": "2026년 5월",
        "title": "보드가 더 부드러워졌어요",
        "summary": "칸반 보드 드래그와 모바일 사용성을 개선했습니다.",
        "items": [
            {"text": "카드 드래그·드롭 정확도를 높였습니다."},
            {"text": "모바일에서 보드 스크롤이 매끄러워졌습니다."},
        ],
    },
    {
        "note_key": "2026-06-v1-3", "version": "v1.3",
        "published_at": "2026-06-10 00:00:00+00", "display_period": "2026년 6월",
        "title": "온보딩이 2분이면 끝나요",
        "summary": "설정 하나를 붙여넣고, 실제로 작동하는지 바로 확인합니다.",
        "items": [
            {"text": "에이전트 연결 설정을 한 번에 복사합니다."},
            {"text": "연결 확인 레일로 실제 동작을 직접 검증합니다."},
        ],
    },
    {
        "note_key": "2026-06-v1-4", "version": "v1.4",
        "published_at": "2026-06-20 00:00:00+00", "display_period": "2026년 6월",
        "title": "멀티계정 전환과 알림 도달 확인이 생겼어요",
        "summary": "로그아웃 없이 계정을 오가고, 알림이 실제로 도달했는지 한눈에 확인하세요.",
        "items": [
            {"text": "여러 계정을 추가해 로그아웃 없이 전환합니다."},
            {"text": "알림 목적지를 한 화면에서 보고·끄고·실제 도달을 테스트합니다."},
            {"text": "에이전트 추가를 모달 한 곳에서 끝냅니다."},
        ],
    },
    {
        "note_key": "2026-06-v1-5", "version": "v1.5",
        "published_at": "2026-06-26 00:00:00+00", "display_period": "2026년 6월",
        "title": "파일 첨부와 미리보기가 생겼어요",
        "summary": "문서에 파일과 이미지를 첨부하고, 스토리지에서 한곳에 모아 확인하세요.",
        "items": [
            {"text": "문서 본문에 파일과 이미지를 첨부합니다."},
            {"text": "첨부한 파일을 스토리지에서 한눈에 관리합니다."},
            {"text": "이미지 썸네일로 내용을 빠르게 확인합니다."},
        ],
    },
]


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)
    if "release_notes" in set(insp.get_table_names()):
        return  # idempotent

    op.create_table(
        "release_notes",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("note_key", sa.Text(), nullable=False),
        sa.Column("version", sa.Text(), nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("display_period", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False, server_default=""),
        sa.Column("items", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("is_published", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    )
    op.create_unique_constraint("uq_release_notes_note_key", "release_notes", ["note_key"])
    op.create_index("ix_release_notes_published_at", "release_notes", ["published_at"])
    op.create_index("ix_release_notes_is_published", "release_notes", ["is_published"])

    # 시드(create 직후만·무손실 이관 + v1.5 추가). id/타임스탬프는 server_default.
    ins = sa.text(
        "INSERT INTO release_notes (note_key, version, published_at, display_period, title, summary, items) "
        "VALUES (:note_key, :version, :published_at, :display_period, :title, :summary, CAST(:items AS jsonb))"
    )
    for n in _SEED:
        op.execute(ins.bindparams(
            note_key=n["note_key"], version=n["version"], published_at=n["published_at"],
            display_period=n["display_period"], title=n["title"], summary=n["summary"],
            items=json.dumps(n["items"], ensure_ascii=False),
        ))


def downgrade() -> None:
    op.drop_table("release_notes")
