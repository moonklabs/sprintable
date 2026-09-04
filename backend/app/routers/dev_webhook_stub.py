"""story e4fc29fa(Phase1·마케팅운영, 페드루 PO 確定 2026-09-04, 조각④) — dev 전용
signed webhook 수신 스텁. `dev_wordpress_stub.py`(조각③c)와 같은 사상 — dev org엔
고객의 실 webhook 목적지가 없어(§7 명시) `webhook_publish.py`가 진짜로 치는 서명된
HTTP 왕복을 검증할 대상이 없던 문제를 채운다.

**진짜 서명 검증**(AC4 明示, wordpress 스텁의 "헤더 존재만 확인"보다 한 단계 더) —
이 스텁은 실제로 `WEBHOOK_TEST_STUB_SECRET`으로 HMAC을 재계산해 대조한다(dev 전용
고정 시크릿 — 실서비스 고객 자격이 아니라 우리 스스로 만든 테스트 연결의 공유 비밀).
`(connection_id, nonce)` 재전송은 `webhook_delivery_nonces` UNIQUE 위반으로 409.

**timestamp 창**(정본 §4 "timestamp 창" 明示, 페드루 리뷰 B2, 2026-09-04) — 서명
자체가 유효해도 `|now − timestamp| > _TIMESTAMP_WINDOW_SECONDS`(300s)면 401로
거부한다. nonce 하나만으로는 "같은 요청이 영원히 유효한 채로 어딘가에 유출되면
그 시점 이후 언제든 재생 가능"이라는 잔여 위험이 남는다 — 창을 두면 유출된 요청도
5분이 지나면 저절로 무력화된다(nonce 원장이 영구히 안 커지는 부수 효과도 있다).

URL 경로에 `connection_id`를 심는다(`/deliver/{connection_id}`) — 우리가 만드는
테스트 connection의 target_url 자체를 이렇게 구성해 두면(우리가 통제하는 값이라
가능) 스텁이 별도 헤더 없이 어느 연결의 발송인지 안다. 실 고객 서버는 이 관례를
몰라도 된다(우리 dev 스텁만의 사정 — webhook_publish.py는 target_url을 그대로
POST할 뿐, 이 경로 관례를 모른다).

fail-closed 이중방어(dev_wordpress_stub.py 동형) — 라우터 자체가 `WEBHOOK_TEST_
STUB_ENABLED=true`일 때만 등재 + 기동 시 `assert_webhook_stub_not_registered_in_prod()`
가 prod 오조작을 잡는다."""
from __future__ import annotations

import hashlib
import hmac
import os
import time
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.database import get_db

router = APIRouter(prefix="/api/dev/webhook-stub", tags=["dev-webhook-stub"])

_DEFAULT_TEST_SECRET = "dev-webhook-stub-shared-secret"  # dev 전용 고정값(실 자격 아님).
# story e4fc29fa(조각④, 페드루 리뷰 B2) — 정본 §4가 明示한 "timestamp 창". 서명
# 자체는 유효해도 timestamp가 지금과 너무 동떨어져 있으면 거부한다 — 어딘가로
# 유출된 요청(서명·nonce 포함 그대로)이 nonce 원장 조회 전에도 무한정 재생 가능한
# 잔여 위험을 좁힌다. 300s는 임의값 — 정상 네트워크 지연을 여유 있게 흡수하면서도
# "영원히 유효"보다는 훨씬 좁다(webhook_publish.py는 매 호출마다 새 timestamp를
# 싣는다 — 재시도가 이 창에 걸릴 일은 없다, 이 창은 순수 replay-window 방어).
_TIMESTAMP_WINDOW_SECONDS = 300


def webhook_stub_enabled() -> bool:
    return os.environ.get("WEBHOOK_TEST_STUB_ENABLED", "").strip().lower() == "true"


def stub_test_secret() -> str:
    """story e4fc29fa(조각④) — dev 테스트 connection을 만들 때 이 값과 같은 문자열을
    `encrypted_access_token`에 넣어야 이 스텁이 서명을 통과시킨다(`WEBHOOK_TEST_STUB_
    SECRET` env로 오버라이드 가능·기본값은 이 파일의 고정 문자열)."""
    return os.environ.get("WEBHOOK_TEST_STUB_SECRET", _DEFAULT_TEST_SECRET)


def assert_webhook_stub_not_registered_in_prod() -> None:
    from app.core.config import settings

    if settings.is_prod_deploy and webhook_stub_enabled():
        raise RuntimeError(
            "fail-closed: prod 배포에 WEBHOOK_TEST_STUB_ENABLED가 켜져 있습니다"
            "(story e4fc29fa 조각④ AC4)."
        )


@router.post("/deliver/{connection_id}")
async def deliver(
    connection_id: uuid.UUID,
    request: Request,
    x_sprintable_signature: str | None = Header(default=None),
    x_sprintable_timestamp: str | None = Header(default=None),
    x_sprintable_nonce: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    body = await request.body()

    if not x_sprintable_signature or not x_sprintable_signature.startswith("sha256="):
        raise HTTPException(status_code=401, detail={"code": "signature_missing", "message": "서명 헤더가 없습니다"})
    if not x_sprintable_timestamp or not x_sprintable_nonce:
        raise HTTPException(status_code=401, detail={"code": "headers_missing", "message": "timestamp/nonce 헤더가 없습니다"})

    try:
        timestamp_value = int(x_sprintable_timestamp)
    except ValueError as exc:
        raise HTTPException(
            status_code=401, detail={"code": "timestamp_invalid", "message": "timestamp가 정수가 아닙니다"},
        ) from exc
    if abs(time.time() - timestamp_value) > _TIMESTAMP_WINDOW_SECONDS:
        raise HTTPException(
            status_code=401,
            detail={"code": "timestamp_out_of_window", "message": f"timestamp가 {_TIMESTAMP_WINDOW_SECONDS}s 창을 벗어났습니다"},
        )

    # 카디르 QA 블로커(2026-09-04, 정본 §4 재확定) — 서명 대상은 body 단독이 아니라
    # timestamp·nonce까지 포함(webhook_publish.py::_signed_payload와 동일 구성) —
    # 그래야 공격자가 헤더의 timestamp·nonce만 새 값으로 바꿔치기해 재전송해도
    # 서명이 안 맞아 401로 막힌다(재전송 방지가 실제로 성립하는 계약).
    signed_payload = f"{x_sprintable_timestamp}.{x_sprintable_nonce}.".encode() + body
    expected = hmac.new(stub_test_secret().encode(), signed_payload, hashlib.sha256).hexdigest()
    got = x_sprintable_signature.removeprefix("sha256=")
    # verdict_capture.py::_hmac_match와 동형 상수시간 비교(타이밍 사이드채널 방지).
    if not hmac.compare_digest(expected, got):
        raise HTTPException(status_code=401, detail={"code": "signature_mismatch", "message": "서명이 일치하지 않습니다"})

    from app.models.webhook_delivery_nonce import WebhookDeliveryNonce

    row = WebhookDeliveryNonce(id=uuid.uuid4(), connection_id=connection_id, nonce=x_sprintable_nonce)
    try:
        async with db.begin_nested():
            db.add(row)
            await db.flush()
    except IntegrityError as exc:
        _orig = getattr(exc, "orig", None)
        constraint = getattr(_orig, "constraint_name", None) or getattr(
            getattr(_orig, "__cause__", None), "constraint_name", None,
        )
        if constraint != "uq_webhook_delivery_nonces_connection_nonce":
            raise
        raise HTTPException(
            status_code=409, detail={"code": "replay_rejected", "message": "이미 처리된 nonce입니다(재전송 거부)"},
        ) from exc
    await db.commit()

    payload = await request.json()
    event = payload.get("event")
    external_id = f"webhook-{connection_id}-{payload.get('slug', uuid.uuid4().hex[:8])}"
    return {"received": True, "event": event, "external_id": external_id, "url": None}
