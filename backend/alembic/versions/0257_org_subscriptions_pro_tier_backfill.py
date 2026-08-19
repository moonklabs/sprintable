"""story #2776 — org_subscriptions.tier 'pro' 잔존값 백필(→'business').

그라운딩(2026-08-18, Cloud Run Job pgstat-probe-dev 실측): 0228이 TierEnum을
free/starter/team/business 4티어로 재편하고 `pricing_versions.tier`는 그때 함께
'pro'→'business' 백필했지만(0228 upgrade() 145행), `org_subscriptions.tier`는
스코프 아웃(0228 docstring: "org_subscriptions.tier CHECK 신설... B단계에서" — CHECK뿐
아니라 값 백필 자체도 그 문장이 가리키는 후속에 같이 미뤄진 채 지금까지 비어 있었다)돼
고아 'pro' 값이 org마다 남아 있었다. ee/plan_limits._KNOWN_TIERS가 이 스토리로
{free,starter,team,business}만 알게 되면서, 'pro'로 남은 org는 매 요청마다
"미지 tier" fail-open 경로(로그만 남기고 캡 미검사 통과)를 타게 된다 — 안전하지만
잘못이다(유료 org인데 카탈로그 집행에서 영구히 빠짐). 'pro'가 곧 구 'business'였다는
사실(0228이 이미 증명한 등가— pricing_versions에서 동일 변환 수행)에 의거해 값만
정정한다(신규 스키마/CHECK 없음 — 데이터 전용 마이그).
"""
from __future__ import annotations

from alembic import op

revision = "0257"
down_revision = "0256"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE org_subscriptions SET tier = 'business' WHERE tier = 'pro'")


def downgrade() -> None:
    # 'pro'→'business' 백필의 역이 필요한 시나리오가 없다(0228이 이미 'pro'를 폐지 방향으로
    # 확定 — pricing_versions와 동일하게 단방향). no-op.
    pass
