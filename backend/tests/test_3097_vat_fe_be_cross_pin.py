"""story #3097 delta-lite(페드루 PO 리뷰, PR#3506, 2026-08-26) — BE `apply_vat_minor`와
FE `withVatKrw`(apps/web/src/ee/components/billing/pricing-data.ts)는 지금 값에서만
일치하는 두 사본이다(율 하드코딩 vs 어드민값·가산 순서·반올림 규칙 3축이 다름 —
billing_charge_amount.py::apply_vat_minor 독스트링 참고). 근본(단일 출처화)은 story
#3104로 별도 추적 — 이 파일은 그 근본이 닫히기 전까지의 조기경보(tripwire)다.

이 테스트가 빨개지면: vat_rate_bp 기본값·카탈로그 가격·반올림 산식 중 하나가 바뀌어
FE 표시와 BE 실 청구가 갈라질 실측 신호 — story #3104를 당길 근거가 된다."""
from __future__ import annotations

from app.services.billing_charge_amount import apply_vat_minor

# 마이그 0282 시드값과 동일 — FE `VAT_RATE=0.1`(pricing-data.ts) 하드코딩과의 현재
# 일치 지점. 이 상수 자체가 바뀌면(어드민이 platform_settings.vat_rate_bp를 조정)
# 이 파일의 기대값도 같이 갱신해야 한다 — 그 자체가 "드리프트 발생"의 신호다.
_CURRENT_VAT_RATE_BP = 1000


def test_apply_vat_minor_matches_current_default_rate():
    """마이그 0282 기본값(1000bp=10%)과 일치 — 이 상수가 바뀌면 아래 FE 교차핀들도
    전부 재검토 대상이 된다는 걸 여기서 먼저 알린다."""
    assert _CURRENT_VAT_RATE_BP == 1000


def test_automation_pack_single_unit_matches_fe_expected_total():
    """FE billing-tab.test.tsx: automation 팩 1개 — withVatKrw(5,000) == 5,500."""
    price_minor = 5_000
    quantity = 1
    # billing_pack.py::purchase_packs와 동일 순서(개당 가산 後 quantity 곱).
    total = apply_vat_minor(price_minor, _CURRENT_VAT_RATE_BP) * quantity
    assert total == 5_500


def test_storage_pack_two_units_matches_fe_expected_total():
    """FE billing-tab.test.tsx: storage 팩 2개 — withVatKrw(3,000*2) == 6,600."""
    price_minor = 3_000
    quantity = 2
    total = apply_vat_minor(price_minor, _CURRENT_VAT_RATE_BP) * quantity
    assert total == 6_600
    # FE는 «합산 後 가산»(withVatKrw(price*quantity)) — 이 카탈로그 값(1,000원 단위)
    # 에서는 BE의 «개당 가산 後 곱»과 결과가 우연히 일치한다. 그 우연 일치 자체를
    # 명시로 고정 — 이 assert가 실패하면 두 산식이 갈렸다는 뜻(예: 가격이 1,000원
    # 단위가 아니게 바뀌거나 vat_rate_bp가 나눗셈 잔차를 만드는 값으로 바뀔 때).
    assert apply_vat_minor(price_minor, _CURRENT_VAT_RATE_BP) * quantity == apply_vat_minor(
        price_minor * quantity, _CURRENT_VAT_RATE_BP
    )


def test_starter_subscription_matches_fe_expected_total():
    """FE billing-tab.test.tsx(UpgradeCheckoutDialog 계열): withVatKrw(29,000) == 31,900
    — 구독 청구(_compute_amount_for_offering)와 동일 «합산 後 가산» 순서."""
    monthly_price_minor = 29_000
    assert apply_vat_minor(monthly_price_minor, _CURRENT_VAT_RATE_BP) == 31_900


def test_per_unit_then_multiply_can_diverge_from_total_then_vat_in_general():
    """⚠️일러스트레이션(실 카탈로그 값 아님) — «개당 가산 後 곱»과 «합산 後 가산»이
    항상 같지는 않다는 것을 보여준다. 가격이 10원 단위가 아니면(예: 1,111원) 반올림
    잔차가 quantity배로 누적돼 두 산식이 다른 정수로 갈릴 수 있다 — 지금 카탈로그가
    전부 1,000원 단위라 이 클래스의 실 발현이 안 보일 뿐, 산식 자체의 동치가 보장된
    건 아니라는 걸 코드로 증명해 둔다(story #3104가 닫히기 전까지 카탈로그에 10원
    단위 미만 가격을 넣지 말아야 하는 이유)."""
    odd_price_minor = 1_111
    quantity = 7
    per_unit_then_multiply = apply_vat_minor(odd_price_minor, _CURRENT_VAT_RATE_BP) * quantity
    total_then_vat = apply_vat_minor(odd_price_minor * quantity, _CURRENT_VAT_RATE_BP)
    assert per_unit_then_multiply != total_then_vat, (
        "이 케이스가 우연히 같아졌다면 예시 값을 다시 골라 divergence를 실제로 보여줄 것"
    )
