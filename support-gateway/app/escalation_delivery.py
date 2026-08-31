"""story #3263(지원v1·5에스컬레이션) — escalation_task가 SupportEscalation 행을 만든 뒤
사람에게 실제로 도달시키는 배달 경로. Gateway는 fleet 자격이 0(Blueprint §2 불변식)이라
backend를 직접 authenticated API로 못 부른다 — 대신 SUPPORT_GATEWAY_TOKEN_SECRET(위임
토큰과 같은 대칭키)를 **역방향**으로 재사용해 짧은 TTL JWT를 서명하고, backend가 자기
사본 시크릿으로 검증한다(새 fleet 자격 발급 0, 기존 신뢰관계 재사용뿐).

⚠️토큰 혼동 차단(페드루 PO 조건①) — aud="backend:escalation-events" 클레임으로 위임
토큰(session-token.py 발급, aud 없음)과 구조적으로 분리한다. token_verify.py의
verify_delegated_token()이 aud 있는 토큰을 명시 거부하는 것과 대칭.

배달 실패는 SupportEscalation 행 생성 자체를 막지 않는다(정직 로그로 남기고 재시도 가능한
상태로 보존 — 페드루 PO 확定, 발급~에스컬 사이 멤버 탈퇴 레이스 같은 edge case도 이 폴백
하나로 흡수된다). escalation_task 호출부 중 3곳(classifier/cost_cap/no_fiction_guard)은
handle_turn 본문에서 별도 try/except 없이 직접 호출되므로, 이 함수 자체가 예외를 삼켜야
고객 응대 턴이 배달 실패로 깨지지 않는다."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import jwt

from app.config import settings

logger = logging.getLogger(__name__)

# story #3263 — 위임 토큰(session-token.py)과 구조적으로 분리하는 aud 값. backend
# 쪽(support_escalation_events.py)이 이 정확한 문자열만 accept한다.
ESCALATION_DELIVERY_AUD = "backend:escalation-events"
# 짧게: 유출돼도 피해 창을 최소화(위임 토큰의 300초보다 더 짧다 — 이 토큰은 발급 즉시
# 바로 쓰고 버리는 1회성 배달용이라 더 좁혀도 무해하다).
_DELIVERY_TOKEN_TTL_SECONDS = 60


async def deliver_escalation_event(
    *,
    escalation_id: uuid.UUID,
    org_id: uuid.UUID,
    user_id: uuid.UUID,
    reason: str,
    detail: str,
    conversation_summary: str,
) -> bool:
    """반환값은 순수 관측용(테스트 편의) — 실패해도 예외를 밖으로 던지지 않는다(위 docstring
    참고). True=backend가 2xx로 접수, False=미설정·네트워크 실패·backend 비2xx 전부 포함."""
    if not settings.token_secret:
        logger.warning(
            "escalation delivery skip — SUPPORT_GATEWAY_TOKEN_SECRET not configured escalation_id=%s",
            escalation_id,
        )
        return False
    if not settings.backend_escalation_events_url:
        logger.warning(
            "escalation delivery skip — backend_escalation_events_url not configured escalation_id=%s",
            escalation_id,
        )
        return False

    now = datetime.now(timezone.utc)
    claims = {
        "aud": ESCALATION_DELIVERY_AUD,
        "escalation_id": str(escalation_id),
        "org_id": str(org_id),
        "user_id": str(user_id),
        "reason": reason,
        # story #3263 — 카드 본문에 실물이 실려야 한다(페드루 PO 조건②, "가서 보라" 스텁
        # 금지). detail/conversation_summary를 클레임에 그대로 실어 backend가 neutral_facts에
        # 곧바로 옮겨 담게 한다(별도 body 없이 JWT 하나로 완결 — 위임 토큰과 동일 관례).
        "detail": detail[:2000],
        "conversation_summary": conversation_summary[:2000],
        "exp": now + timedelta(seconds=_DELIVERY_TOKEN_TTL_SECONDS),
        "iat": now,
    }
    token = jwt.encode(claims, settings.token_secret, algorithm="HS256")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                settings.backend_escalation_events_url,
                headers={"Authorization": f"Bearer {token}"},
            )
            resp.raise_for_status()
    except Exception:
        logger.exception(
            "escalation delivery POST failed escalation_id=%s (swallowed — row preserved, retryable)",
            escalation_id,
        )
        return False
    return True
