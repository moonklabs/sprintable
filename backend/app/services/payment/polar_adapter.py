"""PolarAdapter — backend/ee/routers/billing.py의 실 Polar 연동 로직을 무회귀 이관
(#2478 B). 달러 결제 전용(provider=f(currency): usd→polar, A1 03:41Z 確定).

create_checkout·verify_webhook만 기존 backend에 실 로직이 있었다(체크아웃 API 호출·웹훅
서명검증) — 그대로 옮겼을 뿐 로직/응답 형태를 바꾸지 않았다. 나머지(create_customer·
create_billing_key·charge·refund·open_portal·cancel)는 대응하는 기존 backend 로직이
없어(체크아웃이 고객 생성·결제를 암묵 처리하고, 취소는 Polar 쪽 webhook으로만 반영되는
현재 구조) NotImplementedError로 명시한다 — 후속 스토리 대상."""
from __future__ import annotations

import hashlib
import hmac
import logging
from typing import Any

import httpx

from app.core.config import settings
from app.services.payment.base import PaymentProvider

logger = logging.getLogger(__name__)


class PolarAdapter(PaymentProvider):
    def _api_url(self) -> str:
        """Polar API 기본 URL(sandbox/prod 자동 전환) — billing.py._polar_api_url 이관."""
        return "https://sandbox.api.polar.sh" if settings.polar_sandbox else "https://api.polar.sh"

    async def create_checkout(
        self,
        *,
        price_id: str,
        success_url: str,
        cancel_url: str,
        metadata: dict[str, Any] | None = None,
    ) -> dict:
        """Polar Checkout API 호출 — billing.py.create_checkout_session의 PG 호출부 이관.
        토큰 미설정 시 모의 응답(sandbox 개발 편의) 동작도 그대로 옮겼다."""
        if not settings.polar_access_token:
            logger.warning("POLAR_ACCESS_TOKEN not set — returning mock checkout URL")
            return {
                "checkout_url": f"{self._api_url()}/checkout/mock?price={price_id}&success_url={success_url}",
                "checkout_id": None,
                "sandbox": settings.polar_sandbox,
            }
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    f"{self._api_url()}/v1/checkouts/",
                    headers={
                        "Authorization": f"Bearer {settings.polar_access_token}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "product_price_id": price_id,
                        "success_url": success_url,
                        "cancel_url": cancel_url,
                        "metadata": metadata or {},
                    },
                )
                if resp.status_code not in (200, 201):
                    logger.error("Polar checkout error: %s %s", resp.status_code, resp.text)
                    raise RuntimeError("Polar checkout API error")
                data = resp.json()
        except httpx.RequestError as exc:
            logger.exception("Polar API request failed: %s", exc)
            raise RuntimeError("Cannot reach Polar API") from exc

        return {
            "checkout_url": data.get("url"),
            "checkout_id": data.get("id"),
            "sandbox": settings.polar_sandbox,
        }

    def verify_webhook(self, raw_body: bytes, signature: str | None) -> bool:
        """HMAC-SHA256 서명 검증 — billing.py._verify_polar_signature 이관(동일 로직)."""
        secret = settings.polar_webhook_secret
        if not secret:
            logger.warning("POLAR_WEBHOOK_SECRET not set — skipping signature verification (dev only)")
            return True
        if not signature:
            return False
        expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature.removeprefix("sha256="))

    async def create_customer(self, **kwargs: Any) -> dict:
        raise NotImplementedError(
            "PolarAdapter.create_customer — 기존 backend 로직 없음(체크아웃이 고객 생성을 "
            "암묵 처리). 후속 스토리 대상."
        )

    async def create_billing_key(self, **kwargs: Any) -> dict:
        raise NotImplementedError(
            "create_billing_key는 Toss 개념(빌링키 기반 정기결제) — Polar는 구독 객체를 "
            "직접 관리해 해당 없음. TossAdapter(story C) 대상."
        )

    async def charge(self, **kwargs: Any) -> dict:
        raise NotImplementedError(
            "PolarAdapter.charge — 기존 backend 로직 없음(체크아웃 완료가 결제를 대신함). "
            "후속 스토리 대상."
        )

    async def refund(self, **kwargs: Any) -> dict:
        raise NotImplementedError("PolarAdapter.refund — 기존 backend 로직 없음. 후속 스토리 대상.")

    async def open_portal(self, **kwargs: Any) -> dict:
        raise NotImplementedError("PolarAdapter.open_portal — 기존 backend 로직 없음. 후속 스토리 대상.")

    async def cancel(self, **kwargs: Any) -> dict:
        raise NotImplementedError(
            "PolarAdapter.cancel — 기존 backend 로직 없음(취소는 Polar 쪽 subscription.canceled "
            "웹훅으로만 반영되는 현재 구조). 후속 스토리 대상."
        )
