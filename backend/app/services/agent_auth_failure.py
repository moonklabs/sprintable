"""story #2836 — 에이전트 API키 401 인증실패를 기록하고, 임계 연속 회수 도달 시 presence
표면(agent_status)에 반영한다.

⑤(페드루 확定, 시크릿 규율): 원장·로그·이후 모든 신호 payload엔 key_prefix만 — raw_key
값 자체는 이 모듈 밖으로 절대 안 나간다(에러 경로 포함, 아래 함수 바깥으로 raise하지 않음).

⑥(상수로 시작, 근거는 PR 본문에): 유나·미르코 두 실사고 표본 모두 실측 cadence가 "1분 간격"
이었다 — «연속 N회»가 그대로 «N분»이 되는 자연 단위. 5회(=약 5분)를 문지방으로 삼는다:
1~2회는 순간 blip(네트워크 hiccup 등)일 수 있어 매회 신호화하면 소음이고, 5분은 실 사고
(6시간+)에 비하면 훨씬 빠르면서도 사람이 "잠깐 그런가" 착각할 여유는 준다.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select

logger = logging.getLogger(__name__)

AUTH_FAILURE_WINDOW_MINUTES = 5
AUTH_FAILURE_THRESHOLD = 5

_KEY_PREFIX_LEN = 16  # "sk_live_" (8) + raw[:8] (8) — app/repositories/api_key.py::_generate_key와 동일 규약.


def _derive_prefix(raw_key: str) -> str | None:
    if not raw_key.startswith("sk_live_") or len(raw_key) < _KEY_PREFIX_LEN:
        return None
    return raw_key[:_KEY_PREFIX_LEN]


async def _classify(session, prefix: str, now: datetime) -> tuple[str, uuid.UUID | None, uuid.UUID | None, uuid.UUID | None]:
    """AC④ — 추측 금지, 서버가 아는 사실(행 상태)만으로 판별.

    반환: (reason, org_id, api_key_id, member_id). invalid는 뒤 3개가 전부 None(귀속 불가)."""
    from app.models.api_key import ApiKey
    from app.models.team import TeamMember

    row = (
        await session.execute(
            select(ApiKey.id, ApiKey.member_id, ApiKey.team_member_id, ApiKey.revoked_at, ApiKey.expires_at)
            .where(ApiKey.key_prefix == prefix)
            .limit(1)
        )
    ).first()
    if row is None:
        return "invalid", None, None, None

    api_key_id, member_id, team_member_id, revoked_at, expires_at = row
    org_id: uuid.UUID | None = None
    if member_id is not None:
        from app.models.member import Member

        org_row = (
            await session.execute(select(Member.org_id).where(Member.id == member_id))
        ).scalar_one_or_none()
        org_id = org_row
    if org_id is None and team_member_id is not None:
        org_row = (
            await session.execute(
                select(TeamMember.org_id).where(TeamMember.id == team_member_id)
            )
        ).scalar_one_or_none()
        org_id = org_row

    if revoked_at is not None:
        return "revoked", org_id, api_key_id, member_id
    if expires_at is not None and expires_at <= now:
        return "expired", org_id, api_key_id, member_id
    # prefix는 매치했는데 revoked도 expired도 아님 — key_hash 불일치(오타/prefix 우연충돌) 등
    # 원인을 더 좁힐 근거가 없다. 추측 대신 정직하게 invalid로 떨어뜨린다(④ 정신 그대로).
    return "invalid", None, None, None


async def record_auth_failure(raw_key: str) -> None:
    """`_resolve_api_key`의 401 직전에서 호출(auth.py) — 자기 세션을 열어 caller 트랜잭션과
    분리 커밋한다(`_touch_api_key_last_used`와 동일 이유: caller는 401로 곧 예외/rollback,
    이 기록은 그와 무관하게 반드시 남아야 한다). 실패해도 401 응답 자체는 절대 막지 않는다."""
    prefix = _derive_prefix(raw_key)
    if prefix is None:
        return  # 형식 자체가 우리 키가 아님(외부 스캐너 등) — 원장 대상 밖.

    try:
        from app.core.database import async_session_factory
        from app.models.agent_auth_failure import AgentAuthFailure

        now = datetime.now(timezone.utc)
        async with async_session_factory() as s:
            reason, org_id, api_key_id, member_id = await _classify(s, prefix, now)
            s.add(AgentAuthFailure(
                id=uuid.uuid4(), org_id=org_id, api_key_id=api_key_id, member_id=member_id,
                key_prefix=prefix, reason=reason,
            ))

            if member_id is not None:
                since = now - timedelta(minutes=AUTH_FAILURE_WINDOW_MINUTES)
                cnt = (
                    await s.execute(
                        select(func.count()).select_from(AgentAuthFailure).where(
                            AgentAuthFailure.member_id == member_id,
                            AgentAuthFailure.occurred_at >= since,
                        )
                    )
                ).scalar_one()
                # AsyncSession 기본 autoflush=True — 위 add()가 이 execute() 前에 이미 flush돼
                # cnt에 방금 이번 행까지 포함돼 있다(별도 +1 불요 — 처음엔 그렇게 짰다가 realdb
                # 테스트가 임계 1회 조기발화를 잡아냈다).
                if cnt >= AUTH_FAILURE_THRESHOLD:
                    from app.services.agent_anchor_sync import sync_agent_profile_presence

                    await sync_agent_profile_presence(s, member_id, agent_status="auth_failed")

            await s.commit()
    except Exception:
        logger.warning("record_auth_failure failed(무해 — 401 응답엔 무영향)", exc_info=True)
