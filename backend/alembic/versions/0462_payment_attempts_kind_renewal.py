"""⛔ 결제 제외 승격 대역(prod 승격 · 2026-10-26) — 이 파일은 **no-op**이다.

develop의 0462은 결제 시도 표(billing_payment_attempts)의 `kind` CHECK에 'renewal'을 더한다(story 4755: 닫힌 조직에서 정산된 갱신 청구의 환불 주인 행).
결제는 Toss 심사 전이라 prod로 가지 않는다(선생님 10-24 «토스 심사» · 2026-10-26 승격 지시). 그래서 이 승격 브랜치에서만 revision id(0462) ·
down_revision(0461)은 develop과 같게 두고 upgrade/downgrade 본문을 비웠다 — 그래프는 develop과 같고(지름길 간선 0), prod에는
결제 스키마 객체가 생기지 않는다(0410 · 0427 · 0428 대역과 같은 방침).

⚠️ **결제 승격 때 재생 필요**: prod의 alembic_version은 이 no-op을 «적용됨»으로 지나간다. 결제를 올리는 회차에는 develop 원본 0462의
DDL을 prod에서 따로 재생해야 한다(0410 대역 · 0354a 처방 C와 같은 부류).

Revision ID: 0462
Revises: 0461
"""

revision = "0462"
down_revision = "0461"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """no-op — 결제 제외 승격 대역(머리 주석)."""


def downgrade() -> None:
    """no-op — 결제 제외 승격 대역(머리 주석)."""
