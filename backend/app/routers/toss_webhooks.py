"""결제②-C4(story #2495) — Toss 웹훅 수신. Toss는 정기결제 성공/취소를 웹훅으로 보내지
않는다(`toss-adapter-c-plan-v0-1` §0) — 여기로 오는 건 BILLING_DELETED 같은 «보조»
이벤트뿐(원장/이중청구를 못 건드리는 축, TossAdapter.verify_webhook 참고).

⚠️서명 헤더 이름은 Toss 공식 문서에 명시가 없어(2026-08-07 재확認) 아래 후보들을 순서대로
시도한다 — TOSS_WEBHOOK_SECRET을 prod에 올리기 前에 실제로 어느 헤더가 오는지 라이브
실측이 필요하다(그 前까지는 secret 미설정=dev 한정 통과라 무해)."""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.database import get_db
from app.services.org_billing_key import mark_billing_key_deleted
from app.services.payment.toss_adapter import TossAdapter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/webhooks/toss", tags=["billing", "webhooks"])

# 실측 미확認 — 후보 헤더 이름들(관례상 이 셋이 가장 흔함). 첫 매치를 signature로 쓴다.
_CANDIDATE_SIGNATURE_HEADERS = ("TossPayments-Signature", "Toss-Signature", "X-Toss-Signature")


@router.post("")
async def toss_webhook(request: Request, session: AsyncSession = Depends(get_db)) -> dict:
    raw_body = await request.body()

    signature = None
    for header_name in _CANDIDATE_SIGNATURE_HEADERS:
        signature = request.headers.get(header_name)
        if signature is not None:
            break

    if not TossAdapter().verify_webhook(raw_body, signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    try:
        payload = json.loads(raw_body)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    event_type = payload.get("eventType")
    logger.info("Toss webhook received: eventType=%s", event_type)

    if event_type == "BILLING_DELETED":
        customer_key = (payload.get("data") or {}).get("customerKey")
        if customer_key:
            await mark_billing_key_deleted(session, customer_key=customer_key)
        else:
            logger.warning("BILLING_DELETED webhook missing data.customerKey — nothing to mark")
    else:
        logger.info("Toss webhook eventType=%s — no handler(보조 이벤트 축 밖, 무시)", event_type)

    return {"ok": True}
