"""story #183fe7a5(지원v1·후속) — 게이트 해소(approve/reject) → gateway
SupportEscalation.status 동기화. support-gateway/app/escalation_delivery.py(gateway→backend,
게이트 생성 방향)의 반대 방향 — operator_reply_delivery.py(backend→gateway, 운영자 회신)와
같은 SUPPORT_GATEWAY_TOKEN_SECRET을 aud="support-gateway:escalation-resolution"으로 서명한다
(gateway 쪽 검증: support-gateway/app/token_verify.py::verify_escalation_resolution_token).

트리거: gate_service.py::transition_gate()가 work_item_type=="support_escalation" 게이트를
approved|rejected로 전이시킬 때마다 이 배달을 부른다(background task 아님 — 커밋 前 호출이지만,
이 함수 자체가 실패를 삼켜 approve/reject 자체를 절대 안 깨뜨린다, AC3).

⚠️설계 결정(디디, 2026-09-01) — reject 의미론(AC2): approve와 reject **둘 다** gateway에
resolved=True(gateway 쪽 상태값은 'resolved' 하나뿐)로 동기화한다. 근거: 위젯 배너("담당자에게
전달되었습니다")가 전달하는 사실은 "사람이 이 문의를 처리 대상으로 받아 갔는가"이지 "그 사람이
어떤 판정을 내렸는가"가 아니다 — Gate FSM에서 approved/rejected는 둘 다 **종결 상태**(재상신
없이는 pending으로 안 돌아옴)이므로, reject만 미동기화로 남기면 이 스토리가 고치려는 버그
(«게이트만 닫히고 배너는 영구 고정»)가 reject 경로에서 똑같이 재발한다. resolution(실제
approved|rejected 값)은 그대로 실어 보내 gateway가 필요하면 세분화할 수 있게 열어둔다(현재
gateway 응답 스키마는 그 필드를 안 쓴다 — 정직하게 안 쓰는 것뿐, 못 보내는 게 아니다)."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from jose import jwt as jose_jwt

from app.core.config import settings
from app.models.gate import Gate

logger = logging.getLogger(__name__)

# gateway 쪽(support-gateway/app/token_verify.py::ESCALATION_RESOLUTION_AUD)과 문자열이 정확히
# 같아야 한다 — 프로세스가 분리돼 있어 상수 공유 불가, 값만 계약으로 고정.
ESCALATION_RESOLUTION_AUD = "support-gateway:escalation-resolution"
_DELIVERY_TOKEN_TTL_SECONDS = 60


async def deliver_escalation_resolution_for_gate(*, gate: Gate, new_status: str) -> bool:
    """gate.neutral_facts에서 support_escalation_id를 역참조해 배달한다. 호출부
    (gate_service.py::transition_gate)가 이미 검증·전이 완료한 Gate 객체를 그대로 넘긴다 —
    이 함수는 그 신뢰를 재검증하지 않는다(operator_reply_delivery.py와 달리, 여기는 사용자
    입력이 아니라 이미 커밋 경로 안의 신뢰된 호출)."""
    if gate.work_item_type != "support_escalation":
        logger.warning(
            "escalation resolution sync skip — gate_id=%s not a support_escalation gate", gate.id
        )
        return False

    escalation_id_raw = (gate.neutral_facts or {}).get("support_escalation_id")
    if not escalation_id_raw:
        logger.warning(
            "escalation resolution sync skip — gate_id=%s missing support_escalation_id in neutral_facts",
            gate.id,
        )
        return False
    try:
        escalation_id = uuid.UUID(str(escalation_id_raw))
    except ValueError:
        logger.warning(
            "escalation resolution sync skip — gate_id=%s malformed support_escalation_id=%r",
            gate.id, escalation_id_raw,
        )
        return False

    return await deliver_escalation_resolution(escalation_id=escalation_id, resolution=new_status)


async def deliver_escalation_resolution(*, escalation_id: uuid.UUID, resolution: str) -> bool:
    """반환값은 순수 관측용(테스트 편의) — 실패해도 예외를 밖으로 던지지 않는다(위
    docstring 참고). True=gateway가 2xx로 접수, False=미설정·네트워크 실패·비2xx 전부 포함."""
    if not settings.support_gateway_token_secret:
        logger.warning(
            "escalation resolution sync skip — SUPPORT_GATEWAY_TOKEN_SECRET not configured escalation_id=%s",
            escalation_id,
        )
        return False
    if not settings.support_gateway_escalation_resolution_url:
        logger.warning(
            "escalation resolution sync skip — support_gateway_escalation_resolution_url not configured "
            "escalation_id=%s",
            escalation_id,
        )
        return False

    now = datetime.now(timezone.utc)
    claims = {
        "aud": ESCALATION_RESOLUTION_AUD,
        "escalation_id": str(escalation_id),
        "resolution": resolution,
        "exp": now + timedelta(seconds=_DELIVERY_TOKEN_TTL_SECONDS),
        "iat": now,
    }
    try:
        token = jose_jwt.encode(claims, settings.support_gateway_token_secret, algorithm="HS256")
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                settings.support_gateway_escalation_resolution_url,
                headers={"Authorization": f"Bearer {token}"},
            )
            resp.raise_for_status()
    except Exception:
        logger.exception(
            "escalation resolution sync POST failed escalation_id=%s resolution=%s "
            "(swallowed — 위젯 배너는 다음 성공한 동기화까지 정체될 뿐, 데이터 유실 아님)",
            escalation_id, resolution,
        )
        return False
    return True
