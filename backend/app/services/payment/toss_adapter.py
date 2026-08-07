"""TossAdapter — 원화 정기결제(빌링키) PG 어댑터(결제②-C, `toss-adapter-c-plan-v0-1`).

C1(story #2492)은 `create_billing_key`만 실 구현한다 — 나머지(charge/refund/open_portal/
cancel/verify_webhook)는 후속 스토리(C2~C4) 대상으로 `NotImplementedError`(PolarAdapter와
동일 관례: 조용히 틀린 동작보다 명확한 실패).

⭐Toss는 Polar와 근본이 다르다(§0) — 구독 객체를 PG가 관리하지 않고, 우리가 정기결제
스케줄러와 원장을 직접 소유한다. `create_billing_key`가 그 시작점: FE 위젯이 카드 인증을
마치면 일회성 `authKey`를 돌려주는데, 이걸로 서버가 실제 `billingKey`(재사용 가능한 결제
토큰)를 발급받는다."""
from __future__ import annotations

import base64
import logging
from typing import Any

import httpx

from app.core.config import settings
from app.services.payment.base import PaymentProvider

logger = logging.getLogger(__name__)

_API_BASE = "https://api.tosspayments.com"
# docs.tosspayments.com/reference — 빌링키 발급(2026-08-07 공식 문서 직접 대조).
_ISSUE_BILLING_KEY_PATH = "/v1/billing/authorizations/issue"


class TossAdapter(PaymentProvider):
    def _auth_header(self) -> dict[str, str]:
        """Basic 인증 — 시크릿 키를 username으로, password는 빈 문자열(Toss 관례:
        `secretKey:` 그대로 base64). 시크릿 키 미설정 시 여기서 명시 실패(PolarAdapter의
        "토큰 없으면 mock 응답"과 다르게 결제는 mock 왕복 자체가 의미 없어 fail-closed)."""
        if not settings.toss_payments_secret_key:
            raise RuntimeError("TOSS_PAYMENTS_SECRET_KEY not set — cannot call Toss API")
        token = base64.b64encode(f"{settings.toss_payments_secret_key}:".encode()).decode()
        return {"Authorization": f"Basic {token}", "Content-Type": "application/json"}

    async def create_billing_key(self, *, auth_key: str, customer_key: str) -> dict:
        """POST /v1/billing/authorizations/issue — FE 위젯이 넘긴 authKey + customerKey로
        재사용 가능한 billingKey를 발급받는다. 응답 그대로 반환(billingKey 평문 포함 —
        호출자가 즉시 암호화해 저장하고 이 dict를 더 들고 있지 않아야 한다, 로깅 금지)."""
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(
                    f"{_API_BASE}{_ISSUE_BILLING_KEY_PATH}",
                    headers=self._auth_header(),
                    json={"authKey": auth_key, "customerKey": customer_key},
                )
        except httpx.RequestError as exc:
            logger.exception("Toss billing key issuance request failed")
            raise RuntimeError("Cannot reach Toss API") from exc

        if resp.status_code not in (200, 201):
            # ⛔응답 바디를 그대로 로깅하지 않는다 — Toss 에러 응답이 요청 파라미터를 echo하는
            # 경우가 있어(예: customerKey) 민감정보 유출 표면을 늘릴 수 있다. code/status만.
            body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            logger.error(
                "Toss billing key issuance error: status=%s code=%s",
                resp.status_code, body.get("code"),
            )
            raise RuntimeError(f"Toss billing key issuance failed: {body.get('code', resp.status_code)}")

        return resp.json()

    async def create_customer(self, **kwargs: Any) -> dict:
        raise NotImplementedError(
            "TossAdapter.create_customer — Toss는 고객 개념이 빌링키에 암묵 포함(customerKey"
            "만 서버에서 발급). 별도 API 없음."
        )

    async def create_checkout(self, **kwargs: Any) -> dict:
        raise NotImplementedError(
            "TossAdapter.create_checkout — Toss는 호스티드 체크아웃 세션이 아니라 빌링키 발급"
            "위젯 플로우(create_billing_key 참고). 해당 없음."
        )

    async def charge(self, **kwargs: Any) -> dict:
        raise NotImplementedError("TossAdapter.charge — story C2 대상(billing_orders+원장 연동).")

    def verify_webhook(self, raw_body: bytes, signature: str | None) -> bool:
        raise NotImplementedError("TossAdapter.verify_webhook — story C4 대상(BILLING_DELETED 보조 이벤트).")

    async def refund(self, **kwargs: Any) -> dict:
        raise NotImplementedError("TossAdapter.refund — story C4 대상.")

    async def open_portal(self, **kwargs: Any) -> dict:
        raise NotImplementedError(
            "TossAdapter.open_portal — Toss엔 고객 포털 API가 없다. 카드 교체는 새 빌링키 "
            "발급(create_billing_key 재호출)으로 대체 — FE가 재인증 플로우를 새로 띄운다."
        )

    async def cancel(self, **kwargs: Any) -> dict:
        raise NotImplementedError(
            "TossAdapter.cancel — story C4 대상(빌링키 삭제 API). 구독 자체 취소는 정기결제 "
            "스케줄러(story C3)가 다음 결제를 안 돌리는 것으로 별도 처리."
        )
