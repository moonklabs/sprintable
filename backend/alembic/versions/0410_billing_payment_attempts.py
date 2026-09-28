"""⛔ 결제 제외 승격 대역(prod 승격 · 2026-09-28 · story #4391) — 이 파일은 **no-op**이다.

develop의 0410은 결제 시도 표(`billing_payment_attempts` · story #4335)를 만든다. 결제는 Toss 심사 전이라 prod로 가지 않는다
(선생님 09-26 · 09-28 13:30Z «결제 관련이 섞이면 안되는»). 그래서 이 승격 브랜치에서만 revision id(0410) · down_revision(0409)은
develop과 같게 두고 upgrade/downgrade 본문을 비웠다 — 그래프는 develop과 같고(0411 → 0410 그대로 · 지름길 간선 0), prod에는 결제
스키마 객체가 생기지 않는다.

⚠️ **결제 승격 때 재생 필요**: prod의 alembic_version은 이 no-op을 «적용됨»으로 지나간다. 결제를 올리는 회차에는 develop 원본 0410의
DDL을 prod에서 따로 재생해야 한다(0354a · 처방 C와 같은 부류). 재생 없이 원본 파일로 교체하면 `check_stamp_chain_integrity.py`가
«조상 0410의 산출물(billing_payment_attempts) 없음»으로 배포를 멈춘다 — 그게 이 대역을 알리는 신호다.

Revision ID: 0410
Revises: 0409
"""

revision = "0410"
down_revision = "0409"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """no-op — 결제 제외 승격 대역(머리 주석)."""


def downgrade() -> None:
    """no-op — 결제 제외 승격 대역(머리 주석)."""
