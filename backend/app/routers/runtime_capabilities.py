"""S6(유나/미르코 정합용): 지원 런타임 목록 노출 — S4 픽커/온보딩 FE가 이 계약으로 소비한다.

읽기전용·경량·인증만(org-무관 — 전 org에 동일 백엔드 capability). 계약/판정 근거는
``app.services.agent_onboarding_config.list_runtime_capabilities`` SSOT 참조.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.dependencies.auth import AuthContext, get_current_user
from app.services.agent_onboarding_config import list_runtime_capabilities

router = APIRouter(prefix="/api/v2/runtime-capabilities", tags=["runtime-capabilities"])


class RuntimeCapability(BaseModel):
    slug: str
    display_name: str
    supported: bool
    tier: str | None = None
    transport: str | None = None
    mcp_transport: list[str] = []
    prompt_file: str | None = None
    guide_filename: str | None = None
    supports_event_push: bool = False
    icon: str | None = None


@router.get("", response_model=list[RuntimeCapability])
async def get_runtime_capabilities(
    _auth: AuthContext = Depends(get_current_user),
) -> list[dict]:
    return list_runtime_capabilities()
