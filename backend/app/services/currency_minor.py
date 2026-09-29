"""story #4417 — how many minor units a currency has: one table for the whole ads axis.

Our money columns are integers in minor units (`budget_minor` · `gate.sealed_ads_budget_minor` · spend snapshots): KRW is
counted in won (exponent 0) and USD in cents (exponent 2). The same table is used by

- the boost request, which rejects a currency that is not in it (a sealed amount in an unknown unit can't be compared with
  anything);
- the ad set budget sent to Meta (4415 `lifetime_budget`) — Meta counts budgets in its currency «offset» units, which are
  10 ** exponent for the currencies here (Marketing API «Currencies»: KRW offset 1 · USD offset 100);
- the spend read from Insights, where `spend` is a decimal string in the account currency («5000» won · «12.34» dollars).

A currency outside the table is an error, never a guess. The web keeps its own copy of the exponents
(apps/web/src/components/content/generation-budget-indicator.tsx `CURRENCY_EXPONENTS`); a test pins that it matches this one.
Payments (Toss · subscriptions) have their own amounts and do not use this module.
"""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

CURRENCY_EXPONENTS: dict[str, int] = {"KRW": 0, "USD": 2}


class UnknownCurrencyError(ValueError):
    def __init__(self, currency: object):
        self.currency = currency
        super().__init__(f"currency not in the minor-unit table: {currency!r}")


def currency_exponent(currency: str) -> int:
    """Digits after the decimal point for `currency`; `UnknownCurrencyError` when it is not in the table."""
    try:
        return CURRENCY_EXPONENTS[currency]
    except (KeyError, TypeError):
        raise UnknownCurrencyError(currency) from None


def meta_budget_units(amount_minor: int, currency: str) -> int:
    """An amount in our minor units → Meta's budget units (the currency offset). Equal for every currency in the table
    (offset = 10 ** exponent); the call still goes through here so an unknown currency never reaches Meta."""
    currency_exponent(currency)
    return amount_minor


def decimal_amount_to_minor(amount: str, currency: str) -> int:
    """A decimal string in major units («5000» · «12.34») → an integer in minor units, rounded half up to the currency's
    precision. Raises `UnknownCurrencyError` for a currency outside the table and `ValueError` for a non-number."""
    exponent = currency_exponent(currency)
    try:
        value = Decimal(str(amount).strip())
    except InvalidOperation:
        raise ValueError(f"not a decimal amount: {amount!r}") from None
    if not value.is_finite():
        raise ValueError(f"not a decimal amount: {amount!r}")
    return int((value.scaleb(exponent)).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def minor_to_decimal_amount(amount_minor: int, currency: str) -> str:
    """The reverse, for a provider that answers in major units (the sandbox builds its Insights row with it)."""
    exponent = currency_exponent(currency)
    return format(Decimal(amount_minor).scaleb(-exponent), f".{exponent}f")
