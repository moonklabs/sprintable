"""legacy subscriptions/subscription_checkout_sessions — OSS死·SaaS-only 라이브 선언 주석.

story #2476(결제②-A1후속) 재그라운딩(2026-09-01, 페드루 PO 판정) — 이 두 테이블은 OSS
레포(이 backend)에서 실사용 0건(전수 grep 확認: app/ 어디서도 ORM 모델·raw SQL 소비 없음)
이라 스토리 원 AC 「참조 0이면 drop 또는 死선언」 갈래 중 **死선언** 쪽이 정답이다 — drop은
아니다.

⛔drop 절대 금지: `docs/pk-triage-orm-unmodeled.md`(story a74bdc84, 기존 전수 감사)가 이미
이 두 테이블을 «(보류) SaaS-only 라이브»로 분류해 뒀다 — `subscriptions`는 SaaS 라이브
206 refs, `subscription_checkout_sessions`는 35 refs(둘 다 별도 SaaS 제품/오버레이가
Supabase로 직접 침 — dead 아님). sprintable(OSS)과 SaaS가 같은 물리 Postgres를 공유하는
구조라 여기서 DROP하면 SaaS 프로덕션 데이터가 지워진다. drop 가능 여부는 이 트랙·이 org
밖(SaaS 트랙 판단) — 손 안 댄다.

이 마이그는 순수 `COMMENT ON TABLE`만 한다 — 스키마/데이터 무변경, idempotent(같은 값
재실행 안전), downgrade는 comment를 NULL로 되돌린다(원래 comment 없던 상태). 목적은 차기
감사자가 psql `\\d+ subscriptions`만 봐도 "이거 OSS에서 안 쓴다·SaaS 거다·지우지 마라"를
즉시 알 수 있게 — 코드 주석(app/models/org_subscription.py)과 짝.

OSS 정본은 `org_subscriptions`(app/models/org_subscription.py::OrgSubscription) 하나뿐이다.
"""
from alembic import op

revision = "0298"
down_revision = "0297"
branch_labels = None
depends_on = None

_COMMENT = (
    "OSS-dead / SaaS-only live (story #2476 재그라운딩, docs/pk-triage-orm-unmodeled.md "
    "story a74bdc84). sprintable(OSS) backend는 이 테이블을 안 쓴다 — org_subscriptions가 "
    "OSS 유일 정본. 이 물리 DB를 공유하는 별도 SaaS 제품이 라이브로 쓰는 중이라 DROP 금지."
)


def upgrade() -> None:
    op.execute(f"COMMENT ON TABLE subscriptions IS '{_COMMENT}'")
    op.execute(f"COMMENT ON TABLE subscription_checkout_sessions IS '{_COMMENT}'")


def downgrade() -> None:
    op.execute("COMMENT ON TABLE subscriptions IS NULL")
    op.execute("COMMENT ON TABLE subscription_checkout_sessions IS NULL")
