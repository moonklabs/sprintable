"""#2471(A1) — DB 없이 도는 단위 테스트. TierEnum 재편·FREE_LIMITS 5→3·krw_v1 시드값이
pricing-policy-v2-3 Part3(+ pricing-policy-proposal-v1 §7.1 팩)와 일치하는지 pin한다.
값이 문서와 어긋나면(오타·단위 실수) 이 테스트가 즉시 빨간불 — "판정 선언은 테스트로 pin"."""
from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_migration_0228():
    path = (
        Path(__file__).resolve().parent.parent
        / "alembic" / "versions" / "0228_billing_v2_3_tier_model_offering_catalog.py"
    )
    spec = importlib.util.spec_from_file_location("mig_0228", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_tier_enum_is_v2_3_four_tier():
    from app.models.plan_feature import TierEnum

    assert list(TierEnum.enums) == ["free", "starter", "team", "business"]
    assert "pro" not in TierEnum.enums
    assert "solo" not in TierEnum.enums  # v2.3 D12: solo enum 신설 금지


def test_free_limits_seats_capped_at_3():
    from ee.plan_limits import FREE_LIMITS

    assert FREE_LIMITS["max_members"] == 3  # 선생님 確定 2026-08-06 04:00Z(강제, 그랜드파더링 없음)
    assert FREE_LIMITS["max_orgs_owned"] == 1
    assert FREE_LIMITS["max_projects"] == 1


def _by_tier(rows):
    return {r["tier"]: r for r in rows}


def test_krw_v1_seed_matches_pricing_policy_v2_3_part3():
    """pricing-policy-v2-3 Part3 표(가격·좌석·한도)와 1:1 대조."""
    mod = _load_migration_0228()
    rows = _by_tier(mod.KRW_V1_OFFERINGS)
    assert set(rows) == {"free", "starter", "team", "business"}

    free, starter, team, business = rows["free"], rows["starter"], rows["team"], rows["business"]

    # 가격(공급가, 원)
    assert (free["monthly"], free["annual"]) == (0, 0)
    assert (starter["monthly"], starter["annual"]) == (29_000, 290_000)
    assert (team["monthly"], team["annual"]) == (59_000, 590_000)
    assert (business["monthly"], business["annual"]) == (219_000, 2_190_000)

    # 좌석 — D13: Free/Starter 3, Team 5, Business 15. "뒤로 가는 칸" 없음(단조 증가 검증).
    seats = [free["seats"], starter["seats"], team["seats"], business["seats"]]
    assert seats == [3, 3, 5, 15]
    assert all(a <= b for a, b in zip(seats, seats[1:])), "좌석 수가 티어 상승에서 감소하면 안 됨(D13)"
    assert starter["extra_seat"] is None  # 판매하지 않음
    assert team["extra_seat"] == 11_000
    assert business["extra_seat"] == 9_900

    # 등록 에이전트 — Free만 유한(3, 좌석과 연동), 나머지 무제한(None)
    assert free["max_agents"] == 3
    assert starter["max_agents"] is None
    assert team["max_agents"] is None
    assert business["max_agents"] is None

    # 한도표(Part3)
    assert [free["au"], starter["au"], team["au"], business["au"]] == [50_000, 150_000, 1_000_000, 10_000_000]
    assert [free["conn"], starter["conn"], team["conn"], business["conn"]] == [10, 12, 50, 250]
    assert [free["storage_mb"], starter["storage_mb"], team["storage_mb"], business["storage_mb"]] == [
        5 * 1024, 10 * 1024, 50 * 1024, 250 * 1024,
    ]
    assert [free["file_mb"], starter["file_mb"], team["file_mb"], business["file_mb"]] == [100, 300, 500, 1000]
    assert [free["lab_credit"], starter["lab_credit"], team["lab_credit"], business["lab_credit"]] == [
        500, 1_000, 5_000, 20_000,
    ]
    assert [free["rate"], starter["rate"], team["rate"], business["rate"]] == [120, 300, 1_200, 6_000]
    assert [free["rules"], starter["rules"], team["rules"], business["rules"]] == [3, 20, 100, 1_000]
    assert [free["webhooks"], starter["webhooks"], team["webhooks"], business["webhooks"]] == [0, 3, 10, 100]
    assert [free["replay"], starter["replay"], team["replay"], business["replay"]] == [7, 30, 90, 365]

    # 포함량 도달 시 동작 — Free만 멈춘다(팩 구매 불가)
    assert free["overage"] is False
    assert starter["overage"] is team["overage"] is business["overage"] is True
    assert free["packs"] is None


def test_krw_v1_pack_catalog_matches_d14_and_v2_1_section_7_1():
    mod = _load_migration_0228()
    rows = _by_tier(mod.KRW_V1_OFFERINGS)

    starter_packs = rows["starter"]["packs"]
    assert starter_packs["au"] == {"unit": 150_000, "price_minor": 5_000, "max_packs": 5}
    assert starter_packs["storage_gb"] == {"unit": 10, "price_minor": 3_000, "max_packs": 3}
    # D14: Starter는 연결·Lab·좌석 팩을 팔지 않는다.
    assert "realtime_connections" not in starter_packs
    assert "lab_credit" not in starter_packs

    team_packs = rows["team"]["packs"]
    assert team_packs["au"] == {"unit": 1_000_000, "price_minor": 20_000, "max_packs": 5}
    assert team_packs["realtime_connections"] == {"unit": 50, "price_minor": 30_000, "max_packs": 1}
    assert team_packs["storage_gb"] == {"unit": 100, "price_minor": 15_000, "max_packs": 1}
    assert team_packs["lab_credit"] == {"unit": 5_000, "price_minor": 10_000, "max_packs": None}

    business_packs = rows["business"]["packs"]
    assert business_packs["au"] == {"unit": 10_000_000, "price_minor": 100_000, "max_packs": 10}
    assert business_packs["realtime_connections"] == {"unit": 100, "price_minor": 50_000, "max_packs": 10}
    assert business_packs["storage_gb"] == {"unit": 250, "price_minor": 40_000, "max_packs": 10}
    assert business_packs["lab_credit"] == {"unit": 10_000, "price_minor": 18_000, "max_packs": None}

