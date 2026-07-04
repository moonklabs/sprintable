"""Loop Context Pack MCP 도구 — E-LOOP-LEDGER P1-S12(블루프린트 §2/§P1).

GET /api/v2/loops/{id}/context-pack의 얇은 HTTP 래퍼. read-only·always-allowed(get_workflow_guide
동형) — 에이전트가 loop 작업 중 "의미 유사한 과거 loop/결정/성과"를 on-demand로 직접 pull하는
경로(dispatch 시점 주입[P1-S11]과 별개 — 그건 push, 이건 필요할 때 agent가 스스로 조회하는 pull).
"""
from __future__ import annotations

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class GetLoopContextInput(SprintableInput):
    loop_id: str


async def get_loop_context(args: GetLoopContextInput) -> list[TextContent]:
    """loop의 Context Pack(items[]+embed_available) 조회 — structured JSON 그대로 반환."""
    try:
        result = await client.get(f"/api/v2/loops/{args.loop_id}/context-pack")
        return ok(result)
    except Exception as exc:
        return err(str(exc))
