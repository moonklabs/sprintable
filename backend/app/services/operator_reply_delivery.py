"""story #3279(지원v1·후속) — 운영자 회신 배달(backend→support-gateway).
support-gateway/app/escalation_delivery.py(gateway→backend)의 반대 방향 — 같은
SUPPORT_GATEWAY_TOKEN_SECRET을 aud="support-gateway:operator-reply"로 서명한다(gateway
쪽 검증: support-gateway/app/token_verify.py::verify_operator_reply_token, PR#3672).

트리거: 결재 카드 메시지(msg_metadata.approval_target.work_item_type=="support_escalation")에
**스레드 답장**이 달리면 send_message()(conversations.py)가 이 배달을 background task로
큐잉한다. 카드 최상위(스레드 아닌) 텍스트 답은 여전히 아무 것도 안 한다 —
approval_delivery.py의 기존 정책("챗 텍스트는 게이트를 해소하지 않는다 — 카드 액션만
유효")과 별개 트리거라 그 정책을 안 건드린다.

배달 실패는 정직 로그로만 남기고 예외를 전파하지 않는다(escalation_delivery.py와 동일
계약)."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from jose import jwt as jose_jwt

from app.core.config import settings

logger = logging.getLogger(__name__)

# gateway 쪽(support-gateway/app/token_verify.py::OPERATOR_REPLY_AUD)과 문자열이 정확히
# 같아야 한다 — 프로세스가 분리돼 있어 상수 공유 불가, 값만 계약으로 고정.
OPERATOR_REPLY_AUD = "support-gateway:operator-reply"
_DELIVERY_TOKEN_TTL_SECONDS = 60


async def deliver_operator_reply_for_gate(*, gate_id: uuid.UUID, content: str, sender_id: uuid.UUID) -> bool:
    """카드가 가리키는 gate의 neutral_facts에서 support_escalation_id를 역참조해 배달한다.

    호출부(conversations.py::send_message)는 "이 스레드 답장의 부모 메시지가 support
    카드"까지만 확認하고 gate_id·sender_id를 넘긴다 — 그 게이트가 실제로 지금도 유효한
    support_escalation 게이트인지·**이 답장을 쓴 사람이 실제로 그 게이트의 지정 승인자인지**
    는 여기서 정본(Gate 행)을 다시 읽어 확定한다(부모 메시지의 msg_metadata는 카드 배달
    시점의 스냅샷이라, 그 사이 게이트가 삭제/변조됐을 가능성까지 이 함수가 한 번 더 닫는다).

    ⚠️story #3279 카디르 QA ⑥축 실 finding(2026-09-01, 페드루 PO 자인) — 최초 구현은
    sender를 전혀 안 봐서, 프로젝트 접근권 있는 아무 휴먼의 스레드 답장이 고객에게
    "운영자 회신"으로 배달됐다("카드가 audience 한정이라 비승인자는 답장 자체가 안 된다"는
    가정이 배달 층에선 틀렸다 — non-DM 자동 join까지 겹치면 도달 표면이 넓다). v1은 단일
    승인자 모델(story #2985 designated_approver_id) 그대로 유지 — 대조 실패는 조용한 드롭이
    아니라 **소리내는** 스킵(경고 로그, reason 명시)이어야 나중에 "왜 답장이 고객한테
    안 갔지"를 진단할 수 있다."""
    from sqlalchemy import select

    from app.core.database import async_session_factory
    from app.models.gate import Gate

    async with async_session_factory() as db:
        gate = (await db.execute(select(Gate).where(Gate.id == gate_id))).scalar_one_or_none()
        if gate is None or gate.work_item_type != "support_escalation":
            logger.warning("operator reply skip — gate_id=%s not a support_escalation gate", gate_id)
            return False
        if gate.designated_approver_id is None or gate.designated_approver_id != sender_id:
            logger.warning(
                "operator reply skip — gate_id=%s sender_id=%s is not the designated approver "
                "(designated_approver_id=%s) — unauthorized reply attempt, dropped loudly not silently",
                gate_id, sender_id, gate.designated_approver_id,
            )
            return False
        escalation_id_raw = (gate.neutral_facts or {}).get("support_escalation_id")
        if not escalation_id_raw:
            logger.warning(
                "operator reply skip — gate_id=%s missing support_escalation_id in neutral_facts", gate_id
            )
            return False
        try:
            escalation_id = uuid.UUID(str(escalation_id_raw))
        except ValueError:
            logger.warning(
                "operator reply skip — gate_id=%s malformed support_escalation_id=%r", gate_id, escalation_id_raw
            )
            return False

    return await deliver_operator_reply(escalation_id=escalation_id, content=content)


async def deliver_operator_reply(*, escalation_id: uuid.UUID, content: str) -> bool:
    """반환값은 순수 관측용(테스트 편의) — 실패해도 예외를 밖으로 던지지 않는다(위
    docstring 참고). True=gateway가 2xx로 접수, False=미설정·네트워크 실패·비2xx 전부 포함."""
    if not settings.support_gateway_token_secret:
        logger.warning(
            "operator reply delivery skip — SUPPORT_GATEWAY_TOKEN_SECRET not configured escalation_id=%s",
            escalation_id,
        )
        return False
    if not settings.support_gateway_operator_reply_url:
        logger.warning(
            "operator reply delivery skip — support_gateway_operator_reply_url not configured escalation_id=%s",
            escalation_id,
        )
        return False

    now = datetime.now(timezone.utc)
    claims = {
        "aud": OPERATOR_REPLY_AUD,
        "escalation_id": str(escalation_id),
        "content": content[:4000],
        "exp": now + timedelta(seconds=_DELIVERY_TOKEN_TTL_SECONDS),
        "iat": now,
    }
    try:
        token = jose_jwt.encode(claims, settings.support_gateway_token_secret, algorithm="HS256")
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                settings.support_gateway_operator_reply_url,
                headers={"Authorization": f"Bearer {token}"},
            )
            resp.raise_for_status()
    except Exception:
        logger.exception(
            "operator reply delivery POST failed escalation_id=%s (swallowed — retryable via new reply)",
            escalation_id,
        )
        return False
    return True
