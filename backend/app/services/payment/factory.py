"""provider=f(currency) — 통화로 PG 어댑터를 선택한다(#2478 B). A1(#2471) 03:41Z 確定 규칙과
정합: KRW→toss·USD→polar, per-org. 끊긴 FE `@/lib/payment/factory getPaymentAdapter` 자리를
backend Python으로 정식화한다(06:14Z 미르코 그라운딩 정정 — 실 연동은 처음부터 backend에
있었다).

TossAdapter는 아직 없다(story C) — krw 요청은 조용히 잘못된 어댑터를 주는 대신 명시적으로
실패한다."""
from __future__ import annotations

from app.services.payment.base import PaymentProvider
from app.services.payment.polar_adapter import PolarAdapter

_CURRENCY_PROVIDER = {"usd": "polar", "krw": "toss"}


def get_payment_adapter(currency: str) -> PaymentProvider:
    provider = _CURRENCY_PROVIDER.get(currency)
    if provider is None:
        raise ValueError(f"unsupported currency: {currency!r}")
    if provider == "polar":
        return PolarAdapter()
    raise NotImplementedError(f"TossAdapter not yet implemented (story C) — currency={currency!r}")
