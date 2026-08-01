"""story #2400 — 은퇴한 mockups 기능(#2378 FE·#2394 BE)의 빈 테이블 넷을 지운다.

배경: #2378/#2770이 FE를, #2394가 BE 라우터·모델을 완전히 은퇴시켰지만 DB 테이블 자체는
그때 손대지 않았다(#2394 자체 판단 — DROP 마이그가 없어 "이미 처리된 소거"로 잘못 읽히지
않게, prod에 실제로 남아 있는지 먼저 확認하자는 취지였다). 이 스토리(#2400)가 그 확認이다.

⛔처음엔 「mockup_scenarios가 부모(mockups) 없이 prod에만 살아 있다」는 결함으로 시작됐으나,
PO의 실측을 두 번 되짚은 끝에 결함이 아니었던 것으로 정리됐다:
  - "mockups"(단수 리터럴) 테이블은 dev·prod 어디에도 없다 — 그런데 그건 «지워진» 게 아니라
    «만든 적이 없는» 것이다. `packages/db/supabase/migrations/025_mockups.sql`·
    `20260401025000_mockups.sql` 둘 다 파일명만 그렇고 실제로 만드는 건 `mockup_pages`다.
    전 마이그(alembic+Supabase, git log --all로 전 이력) 어디에도 `REFERENCES.*mockups\b`
    가 없다 — 그 이름을 부모로 참조하는 FK 자체가 없었다.
  - 실제 최상위는 `mockup_pages`(projects/organizations/team_members를 참조)이고, 이건
    dev·prod 둘 다 존재한다 — "부모 없이 자식만 살아있다"는 관측이 성립하지 않는다.
  - 행 수 실측(PO, 2026-08-01): mockup_pages·mockup_components·mockup_scenarios·
    mockup_versions 넷 다 dev·prod 양쪽 **전부 0행** — 완전한 빈 껍데기, 데이터 위험 없음.

⇒ 남는 것은 순수한 후속 청소뿐이다: 코드(#2394)가 이미 지워진 지 오래인 네 테이블을 스키마
에서도 마저 지운다.

FK 순서: mockup_scenarios·mockup_versions·mockup_components 셋 다 mockup_pages를 참조한다
(components는 자기 자신도 참조 — parent_id self-FK, 테이블 자체를 지우는 데는 문제 없음).
자식 셋을 먼저, mockup_pages를 마지막에 명시적 순서로 지운다(CASCADE 한 방으로 묶지 않는 —
"무엇이 같이 지워지는지"를 각 줄이 스스로 말하게 한다).

⚠️2026-08-01 정정(#2402 조사 중 PO 실측): `increment_mockup_version(uuid)`는 애초에 dev·prod
어디에도 없었다 — `baseline/schema.sql`(alembic이 빈 DB에 적용하는 스냅샷)에 `CREATE
FUNCTION`이 단 한 줄도 없다(RLS를 끈 0002_disable_rls.py 즈음 Supabase 시절 보조 함수들이
함께 정리된 것으로 보인다). 그러니 아래 `DROP FUNCTION IF EXISTS`는 실제로 **아무것도 안
지우는 no-op**이다 — "죽은 RPC를 청소한다"는 원래 서술은 틀렸다. 그래도 줄을 남긴다: 이
스크립트는 다른 환경(예: baseline 스냅샷 이전 상태로 남은 아주 오래된 로컬/CI DB)에서 돌 수도
있고, `IF EXISTS`라 있으면 지우고 없으면 조용히 넘어가므로 방어로 남겨두는 비용이 0이다.

⛔⛔IF EXISTS 가드 — 오늘 이 세션에서 "양쪽 환경이 같을 거라 가정했다가 달랐던" 자리를 두 번
겪었다(dev/prod 실측 오독 두 번, PO 스스로 언급). 지금 실측(dev·prod 둘 다 넷 다 존재)으로는
불필요해 보이지만, 이 마이그는 로컬/CI 임시 DB 등 다른 환경에서도 돌 것이므로 방어 비용이
0인 이상 넣는다(PO 판단 — "비용 0인 방어는 그냥 넣는다").
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "0223"
down_revision = "0222"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text("DROP TABLE IF EXISTS mockup_scenarios CASCADE"))
    op.execute(sa.text("DROP TABLE IF EXISTS mockup_versions CASCADE"))
    op.execute(sa.text("DROP TABLE IF EXISTS mockup_components CASCADE"))
    op.execute(sa.text("DROP TABLE IF EXISTS mockup_pages CASCADE"))
    op.execute(sa.text("DROP FUNCTION IF EXISTS increment_mockup_version(uuid)"))


def downgrade() -> None:
    # story #2400: 은퇴한 기능의 빈 테이블 청소 — 되돌릴 이유가 없다(#2378/#2394가 이미
    # 코드를 지웠으므로 스키마만 복원해도 아무것도 못 씀). downgrade는 no-op으로 둔다.
    pass
