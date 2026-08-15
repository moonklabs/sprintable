"""story #2156 AC3/AC4(2026-08-07) — 기존 status=pending·requires_human=false gate 정합화.

`create_gate`가 여태 `requires_human`을 대입하지 않아(merge-type만 `evaluate_merge_gate`가
사후에 채움) DB 컬럼 기본값 False가 그대로 남은 기존 행들 — status는 disposition대로 정확히
pending인데 requires_human=False가 "안 봐도 됨"으로 잘못 신호를 내 인박스에 안 떴다. 코드
수정(create_gate)은 신규 행부터만 맞게 만들 뿐 기존 행은 그대로라, 배포해도 지금 쌓인 pending
게이트들은 여전히 인박스에 안 뜬다 — 이 백필이 없으면 스토리 목표(pending인데 사람에게 안
보이는 문제 해소) 미달이다(카디르 QA, PR#2902④).

status='pending'인 행만 대상(auto_passed는 이미 requires_human=False가 맞다 — 사람이 볼 필요
없는 게 사실). downgrade는 되돌릴 수 없다(백필 前 값이 진짜 False였는지 코드 버그로 인한
False였는지 구분할 근거가 없음 — no-op).
"""
from __future__ import annotations

from alembic import op

revision = "0236"
down_revision = "0235"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE gate SET requires_human = true "
        "WHERE status = 'pending' AND requires_human = false"
    )


def downgrade() -> None:
    pass  # 백필은 원 상태 구분 불가라 되돌리지 않는다(위 docstring 참조).
