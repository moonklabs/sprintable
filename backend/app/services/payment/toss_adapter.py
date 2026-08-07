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
import hashlib
import hmac
import logging
from typing import Any

import httpx

from app.core.config import settings
from app.services.payment.base import PaymentProvider

logger = logging.getLogger(__name__)

_API_BASE = "https://api.tosspayments.com"
# docs.tosspayments.com/reference — 2026-08-07 공식 문서 직접 대조(훈련데이터만 안 믿음).
_ISSUE_BILLING_KEY_PATH = "/v1/billing/authorizations/issue"

# PO 리뷰 블로커(2026-08-07, #2882) — orderId 중복(재시도가 이미 성공한 charge를 다시
# 침) 시 실제 Toss 에러 코드. "ALREADY_PROCESSED_PAYMENT"는 구어체 표기였고 공식 문서
# 재대조 결과 정확한 코드는 이것 — charge_org가 이 값으로 분기(재확認 필요).
DUPLICATED_ORDER_ID = "DUPLICATED_ORDER_ID"


class TossApiError(RuntimeError):
    """Toss 에러 응답(code/message) 구조화 — 호출자가 특정 code(예: DUPLICATED_ORDER_ID)로
    분기해야 하는 경우(charge_org의 중복 재시도 처리) bare RuntimeError 문자열 매칭보다
    안전하다."""

    def __init__(self, code: str, message: str, *, status_code: int):
        self.code = code
        self.status_code = status_code
        super().__init__(f"{code}: {message}" if message else code)


class TossAdapter(PaymentProvider):
    def _auth_header(self) -> dict[str, str]:
        """Basic 인증 — 시크릿 키를 username으로, password는 빈 문자열(Toss 관례:
        `secretKey:` 그대로 base64). 시크릿 키 미설정 시 여기서 명시 실패(PolarAdapter의
        "토큰 없으면 mock 응답"과 다르게 결제는 mock 왕복 자체가 의미 없어 fail-closed)."""
        if not settings.toss_payments_secret_key:
            raise RuntimeError("TOSS_PAYMENTS_SECRET_KEY not set — cannot call Toss API")
        token = base64.b64encode(f"{settings.toss_payments_secret_key}:".encode()).decode()
        return {"Authorization": f"Basic {token}", "Content-Type": "application/json"}

    async def _post(
        self, path: str, *, json: dict, timeout: float, op_label: str, idempotency_key: str | None = None,
    ) -> dict:
        """공용 POST 왕복 — create_billing_key/charge/refund가 공유하는 에러 처리(⛔응답
        바디를 그대로 로깅하지 않는다 — Toss 에러 응답이 요청 파라미터를 echo하는 경우가
        있어 customerKey 등 민감정보 유출 표면을 늘릴 수 있다. code/status만 남긴다).
        idempotency_key가 있으면 `Idempotent-Key` 헤더로 전송(공식 문서 확認, 2026-08-07 —
        재시도가 같은 취소/승인을 중복 처리하지 않게 하는 Toss 측 멱등키)."""
        headers = self._auth_header()
        if idempotency_key is not None:
            headers["Idempotent-Key"] = idempotency_key
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(f"{_API_BASE}{path}", headers=headers, json=json)
        except httpx.RequestError as exc:
            logger.exception("Toss %s request failed", op_label)
            raise RuntimeError("Cannot reach Toss API") from exc

        if resp.status_code not in (200, 201):
            body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            code = body.get("code", str(resp.status_code))
            logger.error("Toss %s error: status=%s code=%s", op_label, resp.status_code, code)
            raise TossApiError(code, f"Toss {op_label} failed", status_code=resp.status_code)

        return resp.json()

    async def _get(self, path: str, *, timeout: float, op_label: str) -> dict:
        """공용 GET 왕복 — 결제 조회(get_payment_by_order_id)용. _post와 동일 에러 처리."""
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.get(f"{_API_BASE}{path}", headers=self._auth_header())
        except httpx.RequestError as exc:
            logger.exception("Toss %s request failed", op_label)
            raise RuntimeError("Cannot reach Toss API") from exc

        if resp.status_code != 200:
            body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            code = body.get("code", str(resp.status_code))
            logger.error("Toss %s error: status=%s code=%s", op_label, resp.status_code, code)
            raise TossApiError(code, f"Toss {op_label} failed", status_code=resp.status_code)

        return resp.json()

    async def create_billing_key(self, *, auth_key: str, customer_key: str) -> dict:
        """POST /v1/billing/authorizations/issue — FE 위젯이 넘긴 authKey + customerKey로
        재사용 가능한 billingKey를 발급받는다. 응답 그대로 반환(billingKey 평문 포함 —
        호출자가 즉시 암호화해 저장하고 이 dict를 더 들고 있지 않아야 한다, 로깅 금지)."""
        return await self._post(
            _ISSUE_BILLING_KEY_PATH,
            json={"authKey": auth_key, "customerKey": customer_key},
            timeout=15,
            op_label="billing key issuance",
        )

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

    async def charge(
        self, *, billing_key: str, customer_key: str, order_id: str, amount_minor: int, order_name: str,
    ) -> dict:
        """POST /v1/billing/{billingKey} — 빌링키 자동결제 승인(story #2493 C2). 성공 웹훅이
        없으므로(§0) **이 동기 응답이 정본**. 최대 60초 소요 가능(Toss 문서 명시) — 호출자
        (org_billing_key.py의 charge_org 등)가 이 함수를 부르기 前에 billing_orders를
        pending으로 먼저 기록해둬야 타임아웃/크래시에도 복구 가능하다(이 어댑터 자체는 그
        규율을 강제하지 않는다 — 순수 PG 왕복 레이어).

        amount_minor: KRW는 무소수 통화라 minor unit이 곧 원 단위 정수 — Toss의 `amount`
        필드에 그대로 넘긴다(달러처럼 /100 환산 불요)."""
        return await self._post(
            f"/v1/billing/{billing_key}",
            json={
                "customerKey": customer_key,
                "orderId": order_id,
                "amount": amount_minor,
                "orderName": order_name,
            },
            timeout=65,  # Toss 문서: 최대 60초 소요 가능 — 여유 5초.
            op_label="charge",
        )

    async def get_payment_by_order_id(self, *, order_id: str) -> dict:
        """GET /v1/payments/orders/{orderId} — PaymentProvider 8메서드 밖의 보조 조회
        (story #2493 C2, PO 리뷰 권장). charge가 `DUPLICATED_ORDER_ID`로 실패했을 때(=
        이 orderId가 이미 처리된 적이 있다는 뜻이지 신규 실패가 아니다) 실제 결제 상태·
        paymentKey를 여기서 확認한다 — Toss 에러 응답 자체엔 그 정보가 없어(공식 문서
        확認) 조회가 유일한 경로."""
        return await self._get(
            f"/v1/payments/orders/{order_id}", timeout=15, op_label="payment lookup",
        )

    def verify_webhook(self, raw_body: bytes, signature: str | None) -> bool:
        """서명 검증 — PolarAdapter(HMAC-SHA256)와 형태는 동일하나, Toss는 이 보조
        이벤트(BILLING_DELETED 등)의 서명 헤더/스킴을 공식 문서가 명시하지 않는다(재확認,
        2026-08-07 — 결제취소 API처럼 레퍼런스가 명확한 축과 다름).

        PO 판단(2026-08-07, story #2495): BILLING_DELETED가 트리거하는 유일한 write는
        org_billing_keys.status='deleted' 멱등 UPDATE — 원장·이중청구를 못 건드리는 축이라
        서명이 약해도 최악은 "재인증 유도"뿐. 그래서:
        ①secret이 설정돼 있으면 검증 필수(있는데 signature가 틀리면 거부)
        ②secret 미설정이면 dev 한정 통과(경고 로그) — **prod로 이 시크릿을 올리기 前에
        Toss가 실제로 이 헤더를 보내는지 라이브로 확인해야 한다**(지금은 미확認, §부록)."""
        secret = settings.toss_webhook_secret
        if not secret:
            logger.warning(
                "TOSS_WEBHOOK_SECRET not set — skipping signature verification (dev only; "
                "BILLING_DELETED write is idempotent so worst case is a spurious re-auth prompt)"
            )
            return True
        if not signature:
            return False
        expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)

    async def refund(
        self,
        *,
        payment_key: str,
        cancel_reason: str,
        cancel_amount_minor: int | None = None,
        idempotency_key: str,
    ) -> dict:
        """POST /v1/payments/{paymentKey}/cancel — 결제취소(전액/부분, story #2495 C4).
        국내는 취소 웹훅도 안 옴(§0) — 이 동기 응답이 정본. cancel_amount_minor 생략 시
        전액환불(Toss 관례). idempotency_key는 호출자가 결정적으로(예: order_id 기반)
        넘겨야 재시도가 중복 취소를 만들지 않는다."""
        body: dict[str, Any] = {"cancelReason": cancel_reason}
        if cancel_amount_minor is not None:
            body["cancelAmount"] = cancel_amount_minor
        return await self._post(
            f"/v1/payments/{payment_key}/cancel",
            json=body,
            timeout=15,
            op_label="refund",
            idempotency_key=idempotency_key,
        )

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
