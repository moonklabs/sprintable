"""provider=f(currency) — 통화로 PG 어댑터를 선택한다(#2478 B). A1(#2471) 03:41Z 確定 규칙과
정합: KRW→toss·USD→polar, per-org. 끊긴 FE `@/lib/payment/factory getPaymentAdapter` 자리를
backend Python으로 정식화한다(06:14Z 미르코 그라운딩 정정 — 실 연동은 처음부터 backend에
있었다).

#2492(C1): TossAdapter 연결 — create_billing_key만 실 구현(나머지는 어댑터 자체가
NotImplementedError, factory는 관여 안 함)."""
from __future__ import annotations

from app.services.payment.base import PaymentProvider
from app.services.payment.polar_adapter import PolarAdapter
from app.services.payment.toss_adapter import TossAdapter

_CURRENCY_PROVIDER = {"usd": "polar", "krw": "toss"}


def get_payment_adapter(currency: str) -> PaymentProvider:
    provider = _CURRENCY_PROVIDER.get(currency)
    if provider is None:
        raise ValueError(f"unsupported currency: {currency!r}")
    if provider == "polar":
        return PolarAdapter()
    return TossAdapter()
