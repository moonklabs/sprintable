"""E-MCP S2: MCP toolset 매니페스트 — 키별 허용 toolset SSOT 엔드포인트.

인증된 API Key의 scope를 정책 매니페스트로 반환. MCP 서버(및 BYO 에이전트 클라이언트)가
이걸로 list 필터 + call-time enforcement(호출 차단)를 수행한다.
"""
from fastapi import APIRouter, Depends, HTTPException

from app.dependencies.auth import AuthContext, get_current_user, require_admin
from app.services.mcp_toolset import build_toolset_catalog, is_tool_allowed, resolve_policy

router = APIRouter(prefix="/api/v2/mcp", tags=["mcp"])


@router.get("/toolset-catalog")
async def get_toolset_catalog(_: AuthContext = Depends(require_admin)) -> dict:
    """E-MCP-RIGHT S1 (2da32fbf): 툴 권한 picker 선택지 SSOT.

    전체 toolset 그룹 + 그룹별 멤버 툴 + core/destructive 플래그 + order. 관리자 전용
    (API 키 권한 picker). manifest(키별 허용 정책)와 별개 — 이건 **선택지 카탈로그**.
    응답 = bare {groups:[...]}; FE route 가 v2 엔벨로프(apiSuccess→{data:{groups}}) 래핑하므로
    BE 는 래핑하지 않는다(이중 래핑 방지). 계약 SSOT = FE `lib/toolset-catalog.ts`.
    """
    return build_toolset_catalog()


@router.get("/manifest")
async def get_mcp_manifest(auth: AuthContext = Depends(get_current_user)) -> dict:
    """현재 키의 허용 toolset 정책(scope/allowed_groups/destructive_allowed).

    SSOT = ApiKey.scope. MCP 서버가 이 정책 + is_tool_allowed로 per-tool enforcement.
    """
    meta = auth.claims.get("app_metadata", {})
    if not meta.get("api_key_id"):
        raise HTTPException(status_code=403, detail="API key required for MCP manifest")
    scope = meta.get("scope") or []
    return resolve_policy(scope)


@router.get("/manifest/check")
async def check_tool_allowed(
    tool: str,
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """단일 도구 호출 허용 여부 — call-time enforcement 보조(서버측 재확인용·defense-in-depth)."""
    meta = auth.claims.get("app_metadata", {})
    if not meta.get("api_key_id"):
        raise HTTPException(status_code=403, detail="API key required")
    scope = meta.get("scope") or []
    return {"tool": tool, "allowed": is_tool_allowed(tool, scope)}
