"""#2471(A1) — 결제② 모델 재편: TierEnum 4티어 + offering_versions 카탈로그(어드민 편집 가능·
불변 버전=히스토리) + grandfather_policies(org↔offering_version 묶임+규칙) + provider-agnostic pricing.

설계문서 billing-arch-modular-pg-ledger-v0-1 §2·§4, 정책 pricing-policy-v2-3 Part3 기준.
PG 호출/웹훅 로직은 손대지 않는다(범위는 B/C) — 이 마이그는 스키마/카탈로그 시드만 다룬다.

## 이 마이그가 하는 것
1. offering_versions 신설 — 티어·통화·가격·좌석·한도·팩을 하나의 불변 행에 스냅샷(v2.1 §13.1
   판정: pricing_versions+plan_tier_limits로 흩어진 개념을 원자적 카탈로그로 교체). krw_v1
   4티어(free/starter/team/business) 시드값은 «초기값»일 뿐 — 이 테이블 자체가 이미 어드민이
   UPDATE/신규 INSERT로 편집 가능한 데이터다(코드 하드코딩 아님). 값이 바뀌면 새 행 + 이전
   행 effective_to로 "닫기"만(append-only) — 그게 곧 요금제 히스토리. 선생님 04:11Z 추가 요건.
1-1. grandfather_policies 신설 — 어떤 org가 어떤 offering_version에 묶였는지(offering_version_id)
   + 그 묶임을 다루는 규칙(auto_migrate_on_new_version·grace_period_days)을 데이터로. org_
   subscriptions.offering_version_id(아래 3)가 "지금 실제로 쓰는 버전"의 단순 포인터라면,
   이 테이블은 그 위의 정책 계층 — 새 버전이 나와도 자동 이전할지/얼마나 고정할지. 어드민
   API/UI 자체는 후속 별 스토리, 이 마이그는 데이터 모델만. ⚠️이번 Free 좌석 5→3은 grandfather
   미사용(강제) — 이 테이블에 아무 행도 만들지 않는다(아래 §Free 좌석 참조).
2. pricing_versions — polar_price_id(NOT NULL) → provider_price_ref(nullable) + provider
   (NOT NULL, toss/polar) + provider=f(currency) CHECK. tier CHECK에서 'pro' 은퇴(테이블
   0행이라 무손실). 이 테이블은 조회 경로(billing.py._current_pricing_version_id)만 있고
   ORM에서 옛 컬럼명을 직접 read하는 곳이 없어 rename 안전.
3. org_subscriptions — polar_customer_id를 nullable로(Toss 구독은 Polar customer가 없음).
   currency·provider 컬럼 신설(둘 다 nullable, provider=f(currency) CHECK) — 실제 값 기입은
   B단계 어댑터가 담당, 이 마이그는 그릇만.
4. plan_tier_limits — starter/business 행 추가(ON CONFLICT DO NOTHING, 0140 선례와 동일
   패턴). 기존 free/team/pro 행은 건드리지 않는다 — 'pro' CHECK/데이터 전환은 B단계에서
   billing.py 웹훅이 더는 'pro'를 쓰지 않게 될 때 함께(지금 지우면 아직 살아있는 Polar
   웹훅 쓰기 경로가 "캡 미정의 tier=무제한" 사각지대로 빠진다 — 회귀).

## 이 마이그가 «하지 않는» 것 (명시적 스코프 아웃)
- org_subscriptions.tier CHECK 신설 — billing.py 웹훅이 여전히 tier="pro"를 쓰는 채로 CHECK를
  걸면 다음 Polar 웹훅에서 즉시 위반한다. B단계(PolarAdapter 이관)에서 웹훅 코드와 함께 묶어
  간다.
- USD offering_versions 시드 — v2.3 정책 문서는 KRW 전용(적용 시장 한국)이다. USD 연납/추가좌석
  가격은 어디에도 결재된 숫자가 없어 이 마이그에서 발명하지 않는다. B단계가 기존 하드코딩
  Polar 카탈로그(_PLAN_CATALOG/_POLAR_PRICE_IDS)를 이관하며 채운다.
- tier2 "legacy subscriptions/plan_tiers"(SaaS overlay 소유, docs/pk-triage-orm-unmodeled.md
  분류상 drop=선생님 승인 필수) 통합 — PO 확認 대기 중(#2471 Discord 04:03Z 스레드), 별도
  후속.

## Free 좌석 3캡(선생님 確定 04:00Z)
offering_versions.free.included_seats=3으로 정책 목표를 반영한다. 기존 5명 초과 Free org를
서버가 강제로 축소하지는 않는다 — ee/plan_limits.py의 FREE_LIMITS만 3으로 낮춰 **신규 초대만
차단**한다(기존 멤버는 유지). storage/agent 등 이 코드베이스의 다른 모든 초과 자원과 동일한
패턴(check_storage_capacity: 신규 업로드만 차단·기존 파일 유지)이라 새 정책이 아니라 기존
관례를 그대로 적용한 것 — 데이터 삭제 마이그가 필요 없다. PR 본문에 이 판단 근거를 남긴다.
"""
from __future__ import annotations

import uuid

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0228"
down_revision = "0227"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # ---------------------------------------------------------------
    # 1. offering_versions 신설
    # ---------------------------------------------------------------
    if not inspector.has_table("offering_versions"):
        op.create_table(
            "offering_versions",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
            sa.Column("tier", sa.Text(), nullable=False),
            sa.Column("currency", sa.Text(), nullable=False),
            sa.Column("version_label", sa.Text(), nullable=False),
            sa.Column("monthly_price_minor", sa.BigInteger(), nullable=False),
            sa.Column("annual_price_minor", sa.BigInteger(), nullable=False),
            sa.Column("included_seats", sa.Integer(), nullable=False),
            sa.Column("extra_seat_price_minor", sa.BigInteger(), nullable=True),
            sa.Column("max_agents", sa.Integer(), nullable=True),
            sa.Column("au_limit", sa.BigInteger(), nullable=False),
            sa.Column("realtime_connection_limit", sa.Integer(), nullable=False),
            sa.Column("storage_mb_limit", sa.BigInteger(), nullable=False),
            sa.Column("max_file_mb", sa.Integer(), nullable=False),
            sa.Column("lab_credit_minor", sa.BigInteger(), nullable=False),
            sa.Column("rate_limit_per_min", sa.Integer(), nullable=False),
            sa.Column("automation_rule_limit", sa.Integer(), nullable=False),
            sa.Column("webhook_limit", sa.Integer(), nullable=False),
            sa.Column("event_replay_days", sa.Integer(), nullable=False),
            sa.Column("overage_allowed", sa.Boolean(), nullable=False),
            sa.Column("pack_catalog", postgresql.JSONB(), nullable=True),
            sa.Column("effective_from", sa.DateTime(timezone=True), nullable=False),
            sa.Column("effective_to", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_by", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
            sa.CheckConstraint("tier IN ('free','starter','team','business')", name="offering_versions_tier_check"),
            sa.CheckConstraint("currency IN ('usd','krw')", name="offering_versions_currency_check"),
        )
        op.create_index(
            "uq_offering_versions_active_tier_currency",
            "offering_versions",
            ["tier", "currency"],
            unique=True,
            postgresql_where=sa.text("effective_to IS NULL"),
        )

    _seed_offering_versions_krw_v1(bind)

    # ---------------------------------------------------------------
    # 2. pricing_versions — provider-agnostic화
    # ---------------------------------------------------------------
    pv_cols = {c["name"] for c in inspector.get_columns("pricing_versions")}
    if "polar_price_id" in pv_cols and "provider_price_ref" not in pv_cols:
        op.alter_column(
            "pricing_versions", "polar_price_id",
            new_column_name="provider_price_ref", nullable=True,
        )
    if "provider" not in pv_cols:
        op.add_column("pricing_versions", sa.Column("provider", sa.Text(), nullable=True))
        bind.execute(sa.text(
            "UPDATE pricing_versions SET provider = CASE currency "
            "WHEN 'krw' THEN 'toss' WHEN 'usd' THEN 'polar' END WHERE provider IS NULL"
        ))
        op.alter_column("pricing_versions", "provider", nullable=False)
        op.create_check_constraint(
            "pricing_versions_provider_check", "pricing_versions", "provider IN ('toss','polar')"
        )
        op.create_check_constraint(
            "pricing_versions_provider_currency_fn", "pricing_versions",
            "(currency = 'krw' AND provider = 'toss') OR (currency = 'usd' AND provider = 'polar')",
        )

    pv_checks = {c["name"] for c in inspector.get_check_constraints("pricing_versions")}
    if "pricing_versions_tier_check" in pv_checks:
        # #2471 A1 실측(로컬 fresh-DB 재현, 0146→0147 진짜 이력을 타는 환경): 0147(live seed)이
        # team/pro × monthly/yearly × usd/krw 10건을 이미 심어둔 채로 이 리비전에 도달할 수
        # 있다(prod의 실제 경로는 0147을 건너뛰어 비어있지만, CI alembic-fresh-db·신규 dev DB는
        # 진짜 이력을 그대로 타 0147을 통과한다 — #2397이 문서화한 바로 그 이력 분기). "테이블이
        # 0행"이라는 가정은 prod 한정 사실이었다 — 여기서 직접 데이터를 다뤄 두 이력 모두 안전.
        # 'pro'는 은퇴하고 'business'가 대신한다(v2.3 D12) — 실 Polar live price row는 그대로
        # 보존하고 tier 값만 재라벨링(가격/식별자 무손실, 정책대로 재설정). 옛 CHECK가 'business'를
        # 허용 안 하므로 반드시 constraint 교체 → UPDATE 순서.
        op.drop_constraint("pricing_versions_tier_check", "pricing_versions", type_="check")
        bind.execute(sa.text("UPDATE pricing_versions SET tier = 'business' WHERE tier = 'pro'"))
        op.create_check_constraint(
            "pricing_versions_tier_check", "pricing_versions",
            "tier IN ('starter','team','business','overage')",
        )

    # ---------------------------------------------------------------
    # 3. org_subscriptions — provider-agnostic 컬럼 + polar_customer_id nullable
    # ---------------------------------------------------------------
    os_cols = {c["name"] for c in inspector.get_columns("org_subscriptions")}
    op.alter_column("org_subscriptions", "polar_customer_id", nullable=True)
    if "currency" not in os_cols:
        op.add_column("org_subscriptions", sa.Column("currency", sa.Text(), nullable=True))
        op.create_check_constraint(
            "org_subscriptions_currency_check", "org_subscriptions",
            "currency IS NULL OR currency IN ('usd','krw')",
        )
    if "provider" not in os_cols:
        op.add_column("org_subscriptions", sa.Column("provider", sa.Text(), nullable=True))
        op.create_check_constraint(
            "org_subscriptions_provider_check", "org_subscriptions",
            "provider IS NULL OR provider IN ('toss','polar')",
        )
        op.create_check_constraint(
            "org_subscriptions_provider_currency_fn", "org_subscriptions",
            "(currency IS NULL AND provider IS NULL) OR "
            "(currency = 'krw' AND provider = 'toss') OR (currency = 'usd' AND provider = 'polar')",
        )
    if "offering_version_id" not in os_cols:
        op.add_column(
            "org_subscriptions",
            sa.Column("offering_version_id", postgresql.UUID(as_uuid=True), nullable=True),
        )
        op.create_foreign_key(
            "fk_org_subscriptions_offering_version_id", "org_subscriptions", "offering_versions",
            ["offering_version_id"], ["id"],
        )

    # ---------------------------------------------------------------
    # 3-1. grandfather_policies 신설 — org↔offering_version 묶임 + 정책 규칙(데이터)
    # ---------------------------------------------------------------
    if not inspector.has_table("grandfather_policies"):
        op.create_table(
            "grandfather_policies",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
            sa.Column("org_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("offering_version_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("offering_versions.id"), nullable=False),
            sa.Column("auto_migrate_on_new_version", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("grace_period_days", sa.Integer(), nullable=True),
            sa.Column("reason", sa.Text(), nullable=False),
            sa.Column("effective_from", sa.DateTime(timezone=True), nullable=False),
            sa.Column("effective_to", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_by", sa.Text(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        )
        op.create_index(
            "uq_grandfather_policies_active_org",
            "grandfather_policies",
            ["org_id"],
            unique=True,
            postgresql_where=sa.text("effective_to IS NULL"),
        )
        op.create_index("ix_grandfather_policies_org_id", "grandfather_policies", ["org_id"])

    # ---------------------------------------------------------------
    # 4. plan_tier_limits — starter/business 행 추가(additive, 기존 행 무변경)
    # ---------------------------------------------------------------
    for tier, storage_mb, file_mb in [
        ("starter", 10 * 1024, 300),
        ("business", 250 * 1024, 1000),
    ]:
        bind.execute(
            sa.text(
                "INSERT INTO plan_tier_limits (tier, max_storage_mb, max_file_mb) "
                "VALUES (:t, :s, :f) ON CONFLICT (tier) DO NOTHING"
            ),
            {"t": tier, "s": storage_mb, "f": file_mb},
        )


# pricing-policy-v2-3 Part3(가격/한도) + pricing-policy-proposal-v1 §7.1(Team/Business 팩 —
# v2.3이 승계) 수치를 그대로 옮긴다. 모듈 레벨 상수로 둬 DB 없이도 pytest가 이 값 자체를
# 정책 문서와 대조할 수 있게 한다(판정을 코드로 pin — #2178 관례).
KRW_V1_OFFERINGS = [
    dict(
        tier="free", monthly=0, annual=0, seats=3, extra_seat=None, max_agents=3,
        au=50_000, conn=10, storage_mb=5 * 1024, file_mb=100, lab_credit=500,
        rate=120, rules=3, webhooks=0, replay=7, overage=False, packs=None,
    ),
    dict(
        tier="starter", monthly=29_000, annual=290_000, seats=3, extra_seat=None, max_agents=None,
        au=150_000, conn=12, storage_mb=10 * 1024, file_mb=300, lab_credit=1_000,
        rate=300, rules=20, webhooks=3, replay=30, overage=True,
        packs={
            "au": {"unit": 150_000, "price_minor": 5_000, "max_packs": 5},
            "storage_gb": {"unit": 10, "price_minor": 3_000, "max_packs": 3},
        },
    ),
    dict(
        tier="team", monthly=59_000, annual=590_000, seats=5, extra_seat=11_000, max_agents=None,
        au=1_000_000, conn=50, storage_mb=50 * 1024, file_mb=500, lab_credit=5_000,
        rate=1_200, rules=100, webhooks=10, replay=90, overage=True,
        packs={
            "au": {"unit": 1_000_000, "price_minor": 20_000, "max_packs": 5},
            "realtime_connections": {"unit": 50, "price_minor": 30_000, "max_packs": 1},
            "storage_gb": {"unit": 100, "price_minor": 15_000, "max_packs": 1},
            "lab_credit": {"unit": 5_000, "price_minor": 10_000, "max_packs": None},
        },
    ),
    dict(
        tier="business", monthly=219_000, annual=2_190_000, seats=15, extra_seat=9_900, max_agents=None,
        au=10_000_000, conn=250, storage_mb=250 * 1024, file_mb=1_000, lab_credit=20_000,
        rate=6_000, rules=1_000, webhooks=100, replay=365, overage=True,
        packs={
            "au": {"unit": 10_000_000, "price_minor": 100_000, "max_packs": 10},
            "realtime_connections": {"unit": 100, "price_minor": 50_000, "max_packs": 10},
            "storage_gb": {"unit": 250, "price_minor": 40_000, "max_packs": 10},
            "lab_credit": {"unit": 10_000, "price_minor": 18_000, "max_packs": None},
        },
    ),
]


def _seed_offering_versions_krw_v1(bind) -> None:
    """이미 krw_v1 행이 있으면 재삽입하지 않는다(append-only 원칙 — 가격 재조정은 새 버전
    행으로, 기존 행 UPDATE 아님)."""
    existing = bind.execute(
        sa.text("SELECT COUNT(*) FROM offering_versions WHERE version_label = 'krw_v1'")
    ).scalar()
    if existing:
        return

    import json as _json

    for r in KRW_V1_OFFERINGS:
        bind.execute(
            sa.text(
                "INSERT INTO offering_versions "
                "(id, tier, currency, version_label, monthly_price_minor, annual_price_minor, "
                "included_seats, extra_seat_price_minor, max_agents, au_limit, "
                "realtime_connection_limit, storage_mb_limit, max_file_mb, lab_credit_minor, "
                "rate_limit_per_min, automation_rule_limit, webhook_limit, event_replay_days, "
                "overage_allowed, pack_catalog, effective_from, created_by) "
                "VALUES (:id, :tier, 'krw', 'krw_v1', :monthly, :annual, :seats, :extra_seat, "
                ":max_agents, :au, :conn, :storage_mb, :file_mb, :lab_credit, :rate, :rules, "
                ":webhooks, :replay, :overage, :packs, now(), 'migration:0228')"
            ),
            {
                "id": uuid.uuid4(),
                "tier": r["tier"],
                "monthly": r["monthly"],
                "annual": r["annual"],
                "seats": r["seats"],
                "extra_seat": r["extra_seat"],
                "max_agents": r["max_agents"],
                "au": r["au"],
                "conn": r["conn"],
                "storage_mb": r["storage_mb"],
                "file_mb": r["file_mb"],
                "lab_credit": r["lab_credit"],
                "rate": r["rate"],
                "rules": r["rules"],
                "webhooks": r["webhooks"],
                "replay": r["replay"],
                "overage": r["overage"],
                "packs": _json.dumps(r["packs"]) if r["packs"] is not None else None,
            },
        )


def downgrade() -> None:
    op.drop_index("ix_grandfather_policies_org_id", table_name="grandfather_policies")
    op.drop_index("uq_grandfather_policies_active_org", table_name="grandfather_policies")
    op.drop_table("grandfather_policies")

    op.drop_constraint("fk_org_subscriptions_offering_version_id", "org_subscriptions", type_="foreignkey")
    op.drop_column("org_subscriptions", "offering_version_id")

    op.drop_constraint("org_subscriptions_provider_currency_fn", "org_subscriptions", type_="check")
    op.drop_constraint("org_subscriptions_provider_check", "org_subscriptions", type_="check")
    op.drop_column("org_subscriptions", "provider")
    op.drop_constraint("org_subscriptions_currency_check", "org_subscriptions", type_="check")
    op.drop_column("org_subscriptions", "currency")
    op.alter_column("org_subscriptions", "polar_customer_id", nullable=False)

    op.drop_constraint("pricing_versions_tier_check", "pricing_versions", type_="check")
    op.execute("UPDATE pricing_versions SET tier = 'pro' WHERE tier = 'business'")
    op.create_check_constraint(
        "pricing_versions_tier_check", "pricing_versions",
        "tier IN ('team','pro','overage')",
    )
    op.drop_constraint("pricing_versions_provider_currency_fn", "pricing_versions", type_="check")
    op.drop_constraint("pricing_versions_provider_check", "pricing_versions", type_="check")
    op.drop_column("pricing_versions", "provider")
    op.alter_column(
        "pricing_versions", "provider_price_ref",
        new_column_name="polar_price_id", nullable=False,
    )

    op.drop_index("uq_offering_versions_active_tier_currency", table_name="offering_versions")
    op.drop_table("offering_versions")

    op.execute("DELETE FROM plan_tier_limits WHERE tier IN ('starter', 'business')")
