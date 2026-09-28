"""Loop Context Pack MCP 도구 — E-LOOP-LEDGER P1-S12(블루프린트 §2/§P1).

GET /api/v2/loops/{id}/context-pack의 얇은 HTTP 래퍼. read-only·always-allowed(get_workflow_guide
동형) — 에이전트가 loop 작업 중 "의미 유사한 과거 loop/결정/성과"를 on-demand로 직접 pull하는
경로(dispatch 시점 주입[P1-S11]과 별개 — 그건 push, 이건 필요할 때 agent가 스스로 조회하는 pull).
"""
from __future__ import annotations

import asyncio
import time

from mcp.types import TextContent

from ..api_client import client
from ..response import err, ok
from ..schemas import SprintableInput


class GetLoopContextInput(SprintableInput):
    loop_id: str


# story #4336 PR2 ②(PO 05:23Z 결정) — 캐시 미스면 백엔드가 202 + 작업(loop_context_pack)을 돌려준다. 에이전트는 «잠시 뒤 다시»를 받으면
# 다시 부르지 않고 맥락 없이 나아갈 공산이 커서, 도구 안에서 짧게 기다린다: 작업 상태를 2초 간격으로 최대 30초 — 끝나면 예전과 같은 모양
# (Context Pack) · 넘으면 그때만 «준비 중 · 작업 id · 같은 도구를 다시 부르면 받음». 30초 = MCP 클라이언트 요청 시한(httpx 30s · 호출 한 번
# 단위)과 MCP 서버 Cloud Run 요청 시한(prod 300s) 밑 · 백엔드 워커가 1분 틱이라 대부분은 한 번 부름에 받는다.
CONTEXT_PACK_POLL_SECONDS = 2.0
CONTEXT_PACK_WAIT_SECONDS = 30.0
# 테스트가 바꿔 끼운다(모듈 속성으로 읽는다).
_sleep = asyncio.sleep
_monotonic = time.monotonic


def _is_queued_job(result: object) -> bool:
    return isinstance(result, dict) and result.get("kind") == "loop_context_pack" and result.get("status") in ("pending", "in_progress")


async def get_loop_context(args: GetLoopContextInput) -> list[TextContent]:
    """loop의 Context Pack(items[]+embed_available) 조회 — structured JSON 그대로 반환."""
    try:
        result = await client.get(f"/api/v2/loops/{args.loop_id}/context-pack")
        if not _is_queued_job(result):
            return ok(result)
        job_id = result["id"]
        deadline = _monotonic() + CONTEXT_PACK_WAIT_SECONDS
        while _monotonic() < deadline:
            await _sleep(CONTEXT_PACK_POLL_SECONDS)
            job = await client.get(f"/api/v2/organizations/{client.org_id}/background-jobs/{job_id}")
            if job.get("status") == "completed":
                return ok((job.get("result") or {}).get("pack"))
            if job.get("status") == "failed":
                return err(RuntimeError(f"context pack job failed: {job.get('error')}"))
        return ok({
            "status": "preparing",
            "job_id": job_id,
            "message": "Context Pack을 준비하고 있어요(30초 안에 끝나지 않음). 같은 도구(sprintable_get_loop_context)를 다시 부르면 받습니다.",
        })
    except Exception as exc:
        return err(exc)
