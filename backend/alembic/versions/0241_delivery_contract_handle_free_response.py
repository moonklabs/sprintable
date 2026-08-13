"""story #2603 P0(블루프린트 delivery-contract-blueprint-v0-1): 전달 계약 판정 단일화의 스키마 토대.

두 컬럼:
- `members.handle` — 에이전트의 안정적 @멘션 핸들(예: mooncli-sprintable). API/MCP 발신
  메시지 본문의 `@handle` 텍스트를 구조화 mentioned_ids와 합집합하는 파서(handle_mention_
  parser.py)가 조회 키로 쓴다. nullable(휴먼은 무의미) — org 내 non-null handle만 unique
  (partial index, 대소문자 무관 충돌 방지를 위해 lower()에 건다).
  **기존 에이전트 백필**: 이 컬럼이 NULL이면 그 에이전트는 @멘션으로 도달 불가능해져(신규
  기본계약=mentions, PO 소급 확定) 사실상 그룹챗에서 말을 못 거는 상태가 된다 — 그래서
  같은 마이그에서 기존 활성 에이전트 전원에게 name을 슬러그화해 handle을 채운다(결정론적·
  가역적 — 순수 데이터 판단이 아니라 새 컬럼을 즉시 쓸 수 있게 만드는 구조 백필이라
  no-pr-for-data 게이트(0166/0167/0240 선례) 대상은 아니라고 판단하나, 선생님 가시성을
  위해 여기 명시한다).
- `conversations.free_response` — AC2(옵트아웃 경로) 대화 스코프 오버라이드. true면 그
  대화에서는 에이전트 recipient의 mentions 기본계약을 all로 완화(단, 그 에이전트가 명시
  mute를 선택했으면 free_response도 mute를 못 뒤집는다 — 회원 자기 선택이 대화 기본값보다
  우선). 기본 false(무회귀 — 신규/기존 대화 전부 지금 동작 유지, 명시 opt-in만 완화).

Revision ID: 0241
Revises: 0240
Create Date: 2026-08-13
"""
from __future__ import annotations

import re
import unicodedata

from alembic import op
import sqlalchemy as sa

revision = "0241"
down_revision = "0240"
branch_labels = None
depends_on = None


def _slugify(name: str) -> str:
    """비ASCII(한글 등)는 버리고 영숫자/하이픈만 남긴다 — @handle 텍스트 파서가 word-boundary
    정규식으로 매칭하므로 handle 자체는 ASCII 토큰이어야 안전하다. 결과가 빈 문자열이면
    (이름이 전부 비ASCII) 호출부가 "agent"로 폴백한다."""
    normalized = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", normalized).strip("-").lower()
    return slug


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)

    members_cols = {c["name"] for c in insp.get_columns("members")}
    if "handle" not in members_cols:
        op.add_column("members", sa.Column("handle", sa.Text(), nullable=True))
        op.create_index(
            "uq_members_org_handle_lower",
            "members",
            ["org_id", sa.text("lower(handle)")],
            unique=True,
            postgresql_where=sa.text("handle IS NOT NULL"),
        )

        # 기존 활성 에이전트 백필(위 docstring 참조) — org별로 slug 충돌 시 -2/-3... 접미사.
        rows = conn.execute(sa.text(
            "SELECT id, org_id, name FROM members WHERE type = 'agent' AND is_active = true "
            "AND handle IS NULL ORDER BY org_id, created_at"
        )).fetchall()
        used_per_org: dict = {}
        for member_id, org_id, name in rows:
            base = _slugify(name) or "agent"
            used = used_per_org.setdefault(org_id, set())
            candidate = base
            n = 2
            while candidate in used:
                candidate = f"{base}-{n}"
                n += 1
            used.add(candidate)
            conn.execute(
                sa.text("UPDATE members SET handle = :handle WHERE id = :id"),
                {"handle": candidate, "id": member_id},
            )

    conversations_cols = {c["name"] for c in insp.get_columns("conversations")}
    if "free_response" not in conversations_cols:
        op.add_column(
            "conversations",
            sa.Column("free_response", sa.Boolean(), nullable=False, server_default=sa.false()),
        )


def downgrade() -> None:
    conn = op.get_bind()
    insp = sa.inspect(conn)

    conversations_cols = {c["name"] for c in insp.get_columns("conversations")}
    if "free_response" in conversations_cols:
        op.drop_column("conversations", "free_response")

    members_cols = {c["name"] for c in insp.get_columns("members")}
    if "handle" in members_cols:
        op.drop_index("uq_members_org_handle_lower", table_name="members")
        op.drop_column("members", "handle")
