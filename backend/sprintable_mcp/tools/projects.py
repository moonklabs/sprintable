"""E-MCP-OPT(story ff6cb90d·doc mcp-multiproject-scoping-design) — 멀티프로젝트 연결 3종 중 ②③.

①(무인자 기본값 근본 판정)은 백엔드 GET /api/v2/auth/me가 SSOT(app/routers/auth.py)."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from ..api_client import _api_key_override, _auth_ctx_cache, client
from ..response import err, ok


class ListProjectsInput(BaseModel):
    model_config = ConfigDict(extra="ignore")


async def list_projects(_args: ListProjectsInput) -> list:
    """caller 키(member)가 접근 가능한 프로젝트 열거(id·이름·org) — 무권한/타조직 프로젝트는
    미노출(존재 유출 오라클 0). 신규 BE 로직 0 — 기존 GET /api/v2/projects(정책B) 얇은 래핑."""
    try:
        result = await client.get("/api/v2/projects")
        return ok(result)
    except Exception as exc:
        return err(str(exc))


class SetDefaultProjectInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    project_id: str


async def set_default_project(args: SetDefaultProjectInput) -> list:
    """멀티프로젝트 키의 기본 프로젝트를 서버에 저장(감사 가능 — member.default_project_changed
    이벤트). 지정 project_id가 caller의 접근 가능 집합 밖이면 403. 설정 직후 무인자 콜부터 이
    프로젝트로 해소되도록 캐시를 갱신한다."""
    try:
        result = await client.patch(
            "/api/v2/auth/me/default-project", json={"project_id": args.project_id}
        )
        # 캐시 갱신 — 프로세스 수명 캐시(ee2f4e58)라 재기동 없이도 이후 무인자 콜이 신규 기본값을
        # 즉시 보게 한다(설정했는데 계속 예전 값/에러 나오면 도구의 존재 의미가 없음). effective
        # 키(_effective_ctx와 동형 — override 있으면 그 키, 없으면 stdio 단일 env 키)만 갱신·
        # 다른 테넌트 키 오염 금지.
        new_default = result.get("resolved_default_project_id")
        if new_default:
            client._project_id = new_default  # stdio(override 無) 경로.
            _key = _api_key_override.get() or client._api_key
            if _key in _auth_ctx_cache:
                _auth_ctx_cache[_key]["project_id"] = new_default
        return ok(result)
    except Exception as exc:
        return err(str(exc))
