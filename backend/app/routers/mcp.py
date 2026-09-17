"""E-MCP S2: MCP toolset 매니페스트 — 키별 허용 toolset SSOT 엔드포인트.

인증된 API Key의 scope를 정책 매니페스트로 반환. MCP 서버(및 BYO 에이전트 클라이언트)가
이걸로 list 필터 + call-time enforcement(호출 차단)를 수행한다.
"""
from fastapi import APIRouter, Depends, HTTPException

from app.dependencies.auth import AuthContext, get_current_user, is_agent_credential, require_admin
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
    # ⛔`api_key_id` truthiness 로 판정하지 말 것 — `dt_live_`(기기 자격증명)는 그 필드를
    # 일부러 안 실어(§5.2.1) 이 게이트가 **403** 을 냈다. 그런데 MCP 서버도 로컬 프록시를
    # 지난다 — 데스크톱 앱이 `SPRINTABLE_API_URL`·`AGENT_API_KEY` 를 둘 다 대체하고
    # (docs/desktop-agent-onboarding.md §5.2), 프록시가 매 요청을 서명하므로 커넥터·MCP
    # 어느 쪽도 수정 없이 `dt_live_` 를 쓴다. 즉 여기가 막히면 **기기 자격증명의 MCP 경로가
    # 통째로 죽는다**(SSE 403 과 동형의 실패). 판정은 과금 축과 공유하는 `is_agent_credential`
    # 로 한다. 휴먼(JWT·`hu_live_`)은 종전대로 403 — 그 경계는 그대로다(무회귀).
    if not is_agent_credential(auth):
        raise HTTPException(status_code=403, detail="API key required for MCP manifest")
    scope = auth.claims.get("app_metadata", {}).get("scope") or []
    return resolve_policy(scope)


@router.get("/manifest/check")
async def check_tool_allowed(
    tool: str,
    auth: AuthContext = Depends(get_current_user),
) -> dict:
    """단일 도구 호출 허용 여부 — call-time enforcement 보조(서버측 재확인용·defense-in-depth)."""
    if not is_agent_credential(auth):  # 위 manifest 와 동형 — `dt_live_` 포함.
        raise HTTPException(status_code=403, detail="API key required")
    scope = auth.claims.get("app_metadata", {}).get("scope") or []
    return {"tool": tool, "allowed": is_tool_allowed(tool, scope)}
