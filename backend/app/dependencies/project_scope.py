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


def enforce_write_scope(auth: AuthContext, request: Request) -> None:
    """API-key write-scope 강제(story d764522c·산티아고 SME 2차 finding).

    ⚠️`_check_api_key_scope`(app/dependencies/auth.py) 그대로 위임하지 않는다 — 그 함수의
    Stage 1(레거시 read/write coarse 게이트)은 `set(scope) & _LEGACY_SCOPES`일 때만 발동하고,
    explicit toolset-scope 키(예: `scope=['docs']`)는 Stage 1을 건너뛰어 Stage 2(path→toolgroup)
    만 적용된다. 그런데 `agent_routing_rules`/`hitl`은 어떤 toolset group에도 대응하지 않는
    admin-adjacent 설정 표면이라 `_PATH_GROUP_PREFIXES`에 없고, 미매핑 path는 "core 취급 허용"이
    기본값(`path_allowed_for_scope`의 over-block 방지 설계)이라 **어떤 toolgroup-scope 키든
    무제한 통과**했다(산티아고 실DB 실증 — `scope=['docs']`로 6개 mutation 전부 성공).

    이 6라우트는 toolgroup 개념이 아예 없으므로, scope 타입 불문 **레거시 'write' 토큰 명시 보유**
    만 통과시킨다(path-group 우회 경로 자체를 안 탐 — 가장 보수적 근본). JWT(human) 경로는
    api_key_id 부재로 자동 스킵(기존 `_check_api_key_scope`와 동일 관례)."""
    if not auth.claims.get("app_metadata", {}).get("api_key_id"):
        return  # JWT(human) 경로 — 스킵.
    scope: list[str] = auth.claims.get("app_metadata", {}).get("scope") or ["read", "write"]
    if "write" not in scope:
        raise HTTPException(status_code=403, detail="API Key scope 'write' required")


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
