"""Sprintable Gateway adapter sidecar for Cursor — E-INJECT-ADAPTERS (카테고리 C).

마지막·유일 카테고리 C — **자식 프로세스 없음**. Cursor Cloud Agents API HTTP 호출.
B(stdio 자식 프로세스 lifetime)와 달리 **run 상태 관리**가 핵심.

구조:
  - 공통 SDK(connectors/sdk/sprintable_sse.py) 재사용 — SSE 소비·dedup·ack·backoff (A/B 동일)
  - 주입 = HTTP POST (spawn 없음):
    - conversation 첫 메시지 → POST /v1/agents (launch) → {agent.id, run.id}
    - 이후 메시지 → POST /v1/agents/{id}/runs (followup) → {run.id}
  - 응답 = GET /v1/agents/{id}/runs/{runId}/stream (Cursor SSE) 수집 → assistant/result 텍스트
  - 응답 → ctx.reply() → POST /api/v2/conversations/{id}/messages

**1-active-run 가드 (C 핵심):** run당 1개만 active(409 agent_busy).
  SDK가 onMessage를 순차 await하므로 한 turn의 stream 완료 전 다음 SSE 이벤트 미처리 →
  자연 직렬화. 추가로 launch/followup 409 시 완료 폴링 후 재시도.

⚠️ 로컬 Cursor 에디터 세션은 외부 주입 경로 없음 → **클라우드 에이전트 한정**.

실측 API (docs.cursor.com/cloud-agent, api.cursor.com, /v1):
  POST /v1/agents {prompt:{text}, repos?} → {agent:{id}, run:{id}}
  POST /v1/agents/{id}/runs {prompt:{text}} → {run:{id, status}}
  GET  /v1/agents/{id}/runs/{runId}/stream → SSE: assistant{text}, result{text}, done
  status: CREATING/RUNNING/FINISHED/ERROR/CANCELLED/EXPIRED
  409 agent_busy: run 1개만 active
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

import httpx

# 공통 SDK import (connectors/sdk/sprintable_sse.py)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sdk"))
from sprintable_sse import SprintableSSEClient, MessageContext  # noqa: E402

logger = logging.getLogger("cursor-sprintable")

CURSOR_API_BASE = os.getenv("CURSOR_API_BASE", "https://api.cursor.com").rstrip("/")
CURSOR_API_KEY = os.getenv("CURSOR_API_KEY", "")
# Cursor 클라우드 에이전트는 repo 기반 — 선택 env (미설정 시 launch body에서 생략)
CURSOR_REPO_URL = os.getenv("CURSOR_REPO_URL", "")
DEFAULT_API_URL = "https://sprintable-backend-dev-57iommnikq-du.a.run.app"
_ACTIVE = {"CREATING", "RUNNING"}
_TERMINAL = {"FINISHED", "ERROR", "CANCELLED", "EXPIRED"}


class CursorCloudClient:
    """Cursor Cloud Agents API HTTP 클라이언트.

    conversation_id → cursor agent_id 매핑으로 stateful 에이전트 유지.
    자식 프로세스 없음 — run 상태 관리로 1-active-run 직렬화.
    """

    def __init__(self) -> None:
        self._http: httpx.AsyncClient | None = None
        # conversation_id → cursor agent_id
        self._agents: dict[str, str] = {}

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {CURSOR_API_KEY}",
            "Content-Type": "application/json",
        }

    async def start(self) -> None:
        self._http = httpx.AsyncClient(timeout=None)
        logger.info("cursor cloud client ready (base=%s)", CURSOR_API_BASE)

    async def _launch(self, text: str) -> tuple[str, str]:
        """POST /v1/agents — 첫 turn (agent 생성). → (agent_id, run_id)."""
        body: dict = {"prompt": {"text": text}}
        if CURSOR_REPO_URL:
            body["repos"] = [{"url": CURSOR_REPO_URL}]
        resp = await self._http.post(
            f"{CURSOR_API_BASE}/v1/agents", headers=self._headers(), json=body, timeout=30.0,
        )
        resp.raise_for_status()
        data = resp.json()
        agent_id = (data.get("agent") or {}).get("id")
        run_id = (data.get("run") or {}).get("id")
        if not agent_id or not run_id:
            raise RuntimeError(f"launch returned no agent/run id: {data}")
        return agent_id, run_id

    async def _followup(self, agent_id: str, text: str) -> str:
        """POST /v1/agents/{id}/runs — 이후 turn. → run_id. 409 시 완료 대기 후 재시도."""
        for attempt in range(6):
            resp = await self._http.post(
                f"{CURSOR_API_BASE}/v1/agents/{agent_id}/runs",
                headers=self._headers(), json={"prompt": {"text": text}}, timeout=30.0,
            )
            if resp.status_code == 409:
                # agent_busy — 이전 run 완료 대기 후 재시도
                logger.info("agent_busy (attempt %d) — waiting for active run", attempt + 1)
                await self._wait_idle(agent_id)
                continue
            resp.raise_for_status()
            run_id = (resp.json().get("run") or {}).get("id")
            if not run_id:
                raise RuntimeError(f"followup returned no run id: {resp.json()}")
            return run_id
        raise RuntimeError("followup failed after retries (agent persistently busy)")

    async def _wait_idle(self, agent_id: str) -> None:
        """active run이 terminal 될 때까지 폴링 (1-active-run 가드)."""
        for _ in range(120):  # 최대 ~2분
            resp = await self._http.get(
                f"{CURSOR_API_BASE}/v1/agents/{agent_id}/runs",
                headers=self._headers(), timeout=15.0,
            )
            if resp.status_code != 200:
                return
            runs = resp.json().get("runs") or resp.json().get("data") or []
            if not any((r.get("status") in _ACTIVE) for r in runs):
                return
            await asyncio.sleep(1.0)

    async def _collect_stream(self, agent_id: str, run_id: str) -> str:
        """GET /v1/agents/{id}/runs/{runId}/stream (Cursor SSE) → assistant/result 텍스트."""
        url = f"{CURSOR_API_BASE}/v1/agents/{agent_id}/runs/{run_id}/stream"
        assistant_parts: list[str] = []
        result_text = ""
        ev_type, data_lines = "message", []
        async with self._http.stream(
            "GET", url,
            headers={**self._headers(), "Accept": "text/event-stream"},
            timeout=httpx.Timeout(connect=15.0, read=300.0, write=15.0, pool=15.0),
        ) as resp:
            resp.raise_for_status()
            async for raw in resp.aiter_lines():
                line = raw.rstrip("\n")
                if line == "":
                    if data_lines:
                        self._handle_stream_event(ev_type, "\n".join(data_lines),
                                                  assistant_parts)
                        # result/done 은 terminal
                        if ev_type in ("result", "done"):
                            try:
                                rt = json.loads("\n".join(data_lines)).get("text")
                                if rt:
                                    result_text = rt
                            except (json.JSONDecodeError, AttributeError):
                                pass
                            if ev_type == "done":
                                break
                    ev_type, data_lines = "message", []
                elif line.startswith(":"):
                    pass
                elif line.startswith("event:"):
                    ev_type = line[6:].strip()
                elif line.startswith("data:"):
                    v = line[5:]
                    data_lines.append(v[1:] if v.startswith(" ") else v)
        # result.text 우선, 없으면 assistant 델타 합성
        return (result_text or "".join(assistant_parts)).strip()

    @staticmethod
    def _handle_stream_event(ev_type: str, data_str: str, assistant_parts: list[str]) -> None:
        if ev_type != "assistant":
            return
        try:
            text = json.loads(data_str).get("text", "")
            if text:
                assistant_parts.append(text)
        except (json.JSONDecodeError, AttributeError):
            pass

    async def run_turn(self, conversation_id: str, text: str) -> str:
        """conversation별 launch-or-followup → stream 수집 → 응답."""
        agent_id = self._agents.get(conversation_id)
        if agent_id is None:
            agent_id, run_id = await self._launch(text)
            self._agents[conversation_id] = agent_id
        else:
            run_id = await self._followup(agent_id, text)
        return await self._collect_stream(agent_id, run_id)

    async def stop(self) -> None:
        if self._http:
            await self._http.aclose()
            self._http = None


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="[cursor-sprintable] %(levelname)s %(message)s",
        stream=sys.stderr,
    )
    api_url = (os.getenv("SPRINTABLE_API_URL", DEFAULT_API_URL) or DEFAULT_API_URL).rstrip("/")
    api_key = os.getenv("SPRINTABLE_API_KEY") or os.getenv("AGENT_API_KEY") or ""
    if not api_key:
        logger.error("SPRINTABLE_API_KEY or AGENT_API_KEY not set — sidecar disabled")
        return
    if not CURSOR_API_KEY:
        logger.error("CURSOR_API_KEY not set — sidecar disabled")
        return

    cursor = CursorCloudClient()
    await cursor.start()

    sse = SprintableSSEClient(api_url=api_url, api_key=api_key)

    async def inject(ctx: MessageContext) -> None:
        try:
            response = await cursor.run_turn(ctx.conversation_id, ctx.content)
        except Exception as exc:
            logger.warning("turn error conv=%s: %s", ctx.conversation_id, exc)
            return
        if response:
            await ctx.reply(response)

    try:
        await sse.run(inject)
    finally:
        await cursor.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
