"""E-MCP-OPT 후속(story f0c99070·doc legacy-project-fallback-sweep-audit §2.1) — 요청시점
project_id 재해소.

`_resolve_api_key`가 API key/agent 인증마다 토큰 해소 시점에 구워 넣는 `app_metadata.project_id`
(`ORDER BY project_id ASC LIMIT 1` 임의값)는 매 요청 갱신되지 않는다 — 이 모듈은 그 굽힌 값을
신뢰하지 않고 **매 요청 재해소**한다: 명시(path/body/query) > X-Project-Id 헤더(has_project_access
검증) > member.default_project_id(요청 시점 재조회) > 단일 접근가능 프로젝트 > 명시 에러(400).
MCP `SprintableClient.require_project_id()`(sprintable_mcp/api_client.py)와 동일 계약 재사용
(신규 발명 금지) — 문구만 REST 호출자에 맞게 조정(`PATCH /api/v2/auth/me/default-project` 참조).
"""
from __future__ import annotations

import uuid

from fastapi import HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies.auth import AuthContext

_AMBIGUOUS_MESSAGE = (
    "여러 프로젝트에 접근 가능한 키입니다. 요청에 project_id를 지정하거나 "
    "PATCH /api/v2/auth/me/default-project로 기본 프로젝트를 설정하세요."
)


async def resolve_required_project_id(
    session: AsyncSession,
    request: Request,
    auth: AuthContext,
    org_id: uuid.UUID,
    *,
    explicit_project_id: uuid.UUID | None = None,
) -> uuid.UUID:
    """이 요청이 스코프할 project_id를 재해소. 해소 불가(멀티프로젝트+미설정+무지정)면 400."""
    from app.services.project_auth import has_project_access

    member_id = auth.user_id if isinstance(auth.user_id, uuid.UUID) else uuid.UUID(str(auth.user_id))

    if explicit_project_id is not None:
        if not await has_project_access(session, member_id, explicit_project_id, org_id):
            raise HTTPException(status_code=403, detail="No access to the specified project")
        return explicit_project_id

    header = request.headers.get("X-Project-Id") if request is not None else None
    if header:
        try:
            header_project_id = uuid.UUID(header)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid X-Project-Id format")
        if not await has_project_access(session, member_id, header_project_id, org_id):
            raise HTTPException(status_code=403, detail="No access to the specified project")
        return header_project_id

    from app.routers.auth import _resolve_project_default
    resolved, _ambiguous, accessible_ids = await _resolve_project_default(session, member_id, org_id)
    if resolved is not None:
        return uuid.UUID(resolved)
    if not accessible_ids:
        raise HTTPException(status_code=403, detail="No accessible project for this member")
    raise HTTPException(
        status_code=400,
        detail={
            "code": "PROJECT_ID_REQUIRED",
            "message": _AMBIGUOUS_MESSAGE,
            "accessible_project_ids": accessible_ids,
        },
    )
