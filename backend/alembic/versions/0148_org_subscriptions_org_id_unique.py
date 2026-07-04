"""E-ADMIN B1(story 553fc58d) 부수 발견: org_subscriptions.org_id UNIQUE 제약 부재 수정.

ORM 모델(`OrgSubscription.org_id`)은 처음부터 `unique=True`를 선언해왔으나, 실 스키마(0096
baseline부터)에는 그 제약이 한 번도 만들어진 적이 없었다(model↔migration drift). 그 결과
`ee/routers/billing.py._update_subscription`의 `ON CONFLICT (org_id) DO UPDATE`가 **실
DB에선 항상 500**(`there is no unique or exclusion constraint matching the ON CONFLICT
specification`)이었다 — 기존 테스트가 전부 mock 세션이라 이 실패 경로를 아무도 잡지 못했다
(E-ADMIN B1 grandfather 배선의 신규 realdb 테스트를 작성하며 발견).

live에 Team/Pro 유료 구독이 0건인 이유가 단지 "아직 아무도 안 샀다"가 아니라 **체크아웃
성공 후 구독 upsert 자체가 실패했을 가능성**을 시사한다 — 이 마이그가 근본 수정이다.

방어적 dedup 선행: 혹시 남아있는 org_id 중복 행이 있으면 UNIQUE 제약 추가가 실패하므로,
행 추가(가장 최신 updated_at) 1건만 남기고 나머지는 제거한 뒤 제약을 건다."""
from __future__ import annotations

from alembic import op

revision = "0148"
# story bda4beac: 원래 down_revision="0147"(pricing 시드) — 0148은 pricing과 무관한
# core 버그 fix(org_subscriptions는 baseline 테이블·같은 model unique=True 선언이 main에도
# 있음)인데 0146/0147(진짜 ee 전용) 사이에 순차 배치된 탓에 main promotion 시 함께
# 누락(#bda4beac 발견 — main엔 0146/0147 파일 자체가 없어 down_revision="0147" 참조가
# KeyError로 그래프 구성 자체를 실패시켜 prod 승격이 막혔다). 0145(공통 core 조상) 직계로
# 재부모해 main 단독으로도 승격 가능하게 근본수정 — main 체인은 이제 0145→0148→0149→...
# 로 pricing 파일 존재 여부와 완전 무관해진다. develop/ee 환경은 이 재부모로 dual-head가
# 된다(core head 0155+ · ee_pricing head 0147) — `alembic upgrade heads`(복수형)로 전환
# 필요, 콜사이트는 ci.yml/migrate.sh/test_migrate_env.py 등에서 함께 갱신.
down_revision = "0145"
branch_labels = ("core",)
depends_on = None


def upgrade() -> None:
    # org_id당 1건만 남김(최신 updated_at 우선, NULL은 최하위, id로 최종 타이브레이크).
    op.execute(
        """
        DELETE FROM org_subscriptions
        WHERE id IN (
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY org_id
                    ORDER BY updated_at DESC NULLS LAST, id DESC
                ) AS rn
                FROM org_subscriptions
            ) ranked
            WHERE rn > 1
        )
        """
    )
    op.create_unique_constraint(
        "uq_org_subscriptions_org_id", "org_subscriptions", ["org_id"]
    )


def downgrade() -> None:
    op.drop_constraint("uq_org_subscriptions_org_id", "org_subscriptions", type_="unique")
