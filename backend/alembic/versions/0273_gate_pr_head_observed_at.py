"""story #2932(완주조건 HIGH2, PR#3357 재재verdict — codex+카디르 일치판단) — stale/순서역전
webhook의 spurious 재-pending 방지.

`reopen_gate_if_new_sha`가 `gate.approved_head_sha != new_head_sha`만으로 재-pending을
판정했다 — GitHub가 웹훅 배달 순서를 보장하지 않으므로(재시도·네트워크 재정렬), 이미 최신
SHA로 승인된 게이트에 **뒤늦게 도착한 옛 synchronize 배달**이 그 옛 SHA와의 불일치만 보고
"최신 검증 SHA에 대한 승인"을 부당하게 재-pending시킬 수 있었다(story #2893의 핵심
보증 — "승인은 그때의 커밋에" — 을 이 클래스가 직접 깬다는 것이 codex/카디르 일치판단).

처방: `pull_request.updated_at`(GitHub가 실 PR 갱신마다 단조증가시키는 타임스탬프, 웹훅
페이로드에 항상 동봉)을 게이트에 워터마크로 기록한다. 새로 도착한 이벤트의 `updated_at`이
이미 관측된 워터마크보다 **오래되면**(<=) 그 배달을 stale로 간주해 SHA 불일치와 무관하게
재-pending을 skip한다 — GitHub API 재조회 없이(폴링 0, story #2893 §4 C1 원칙과 동형)
페이로드 자체의 신호만으로 순서를 검증.

Revision ID: 0273
Revises: 0272
Create Date: 2026-08-22
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0273"
down_revision = "0272"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "gate", sa.Column("pr_head_observed_at", sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("gate", "pr_head_observed_at")
