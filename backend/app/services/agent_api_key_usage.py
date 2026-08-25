"""story #2087 — 에이전트 API 키 사용 이력 감사 트레일. 기록(write)+조회(read) 둘 다.

write(`record_api_key_usage`)는 `_resolve_api_key`(auth.py) 성공 경로 말미에서 호출된다 —
`_touch_api_key_last_used`/`record_auth_failure`(story #2457/#2836)와 동형: 전용 단명
세션(caller `db` 트랜잭션과 분리 커밋)+fail-silent(인증 자체는 절대 안 막음). caller 세션을
쓰지 않는 이유는 story #2457 그대로다 — `get_current_user`는 REST 전반의 공용 진입점이라
caller 세션에 write를 얹으면 그 row/트랜잭션이 응답 완료까지 커넥션을 물고, 부하 시 primary
풀을 고갈시킨다(#2457 실측).

⚠️스로틀 없음(의도적) — `_touch_api_key_last_used`(5분 스로틀)와 다르다. 그 스로틀은
last_used_at 값의 대략적 정확도로 충분해 볼륨 절감이 이득이었지만, 이 원장은 «완전성»이
존재 이유(오늘 실제로 그 완전성 부재 때문에 키 유출 인시던트의 악용 여부를 증명도 반증도
못 했다) — 샘플링하면 목적 자체가 무효화된다."""
from __future__ import annotations

import logging
import uuid
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

if TYPE_CHECKING:
    from fastapi import Request

logger = logging.getLogger(__name__)

DEFAULT_LIST_LIMIT = 50
MAX_LIST_LIMIT = 200


async def record_api_key_usage(
    *,
    api_key_id: uuid.UUID,
    org_id: uuid.UUID | None,
    member_id: uuid.UUID | None,
    request: "Request | None",
) -> None:
    try:
        from app.core.database import async_session_factory
        from app.models.agent_api_key_usage_log import AgentApiKeyUsageLog

        endpoint = request.url.path if request is not None else "unknown"
        method = request.method if request is not None else "unknown"
        remote_ip = request.client.host if request is not None and request.client else None

        async with async_session_factory() as s:
            s.add(AgentApiKeyUsageLog(
                id=uuid.uuid4(), api_key_id=api_key_id, org_id=org_id, member_id=member_id,
                endpoint=endpoint, method=method, remote_ip=remote_ip,
            ))
            await s.commit()
    except Exception:
        logger.warning("record_api_key_usage failed api_key_id=%s", api_key_id, exc_info=True)


async def list_api_key_usage(session: AsyncSession, api_key_id: uuid.UUID, *, limit: int = DEFAULT_LIST_LIMIT):
    """읽기 전용 — caller 세션(요청-수명 get_db) 그대로 사용해도 안전(REST 전반 공용 hot-path인
    write와 달리, 이 조회는 admin/owner가 명시로 여는 화면 1건당 1회뿐)."""
    from app.models.agent_api_key_usage_log import AgentApiKeyUsageLog

    limit = min(max(limit, 1), MAX_LIST_LIMIT)
    result = await session.execute(
        select(AgentApiKeyUsageLog)
        .where(AgentApiKeyUsageLog.api_key_id == api_key_id)
        .order_by(AgentApiKeyUsageLog.occurred_at.desc())
        .limit(limit)
    )
    return list(result.scalars().all())
