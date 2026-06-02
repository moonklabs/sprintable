"""Sprintable Gateway adapter host for Gemini — E-INJECT-ADAPTERS (카테고리 B).

카테고리 B 둘째 — codex 호스트(connectors/codex-sprintable/host.py)와 동형 골격.
차이 = RPC 레이어: gemini는 `gemini --acp` (Agent Client Protocol, 표준 JSON-RPC/stdio).
codex app-server의 자체 RPC와 달리 ACP는 표준이라 향후 ACP 런타임에 재사용 가능.

구조 (codex와 동일):
  - 공통 SDK(connectors/sdk/sprintable_sse.py) 재사용 — SSE 소비·dedup·ack·backoff
  - gemini --acp (JSON-RPC/stdio)를 spawn/own
  - SSE 이벤트마다 session/new(최초) + session/prompt로 turn 주입
  - session/update(agent_message_chunk) 스트림 수집 → session/prompt 응답(stopReason)에서 확정
  - 응답 → ctx.reply() → POST /api/v2/conversations/{id}/messages

실측 ACP (@zed-industries/agent-client-protocol 0.4.5, PROTOCOL_VERSION=1):
  initialize({protocolVersion, clientCapabilities}) → session/new({cwd, mcpServers})
  → session/prompt({sessionId, prompt:[ContentBlock]}) → {stopReason}
  client notification: session/update {sessionId, update:{sessionUpdate:"agent_message_chunk", content}}
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

# 공통 SDK import (connectors/sdk/sprintable_sse.py)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sdk"))
from sprintable_sse import SprintableSSEClient, MessageContext  # noqa: E402

logger = logging.getLogger("gemini-sprintable")

GEMINI_BIN = os.getenv("GEMINI_BIN", "gemini")
DEFAULT_API_URL = "https://sprintable-backend-dev-57iommnikq-du.a.run.app"
ACP_PROTOCOL_VERSION = 1


class GeminiAcpServer:
    """gemini --acp JSON-RPC/stdio 자식 프로세스 호스트 (ACP 표준).

    한 번 spawn해서 lifetime 동안 own. shutdown 시 SIGTERM→kill.
    codex host와 동형 — RPC 메서드만 ACP 표준으로 교체.
    """

    def __init__(self, cwd: str | None = None) -> None:
        self._cwd = cwd or os.getcwd()
        self._proc: asyncio.subprocess.Process | None = None
        self._req_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        # turn 응답 수집: session/update agent_message_chunk 누적
        self._turn_messages: list[str] = []
        self._reader_task: asyncio.Task | None = None
        self._session_id: str | None = None

    async def start(self) -> None:
        """gemini --acp spawn + initialize 핸드셰이크."""
        self._proc = await asyncio.create_subprocess_exec(
            GEMINI_BIN, "--acp",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._cwd,
        )
        self._reader_task = asyncio.create_task(self._read_loop())

        # ACP initialize
        await self._request("initialize", {
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientCapabilities": {
                "fs": {"readTextFile": False, "writeTextFile": False},
                "terminal": False,
            },
        })
        logger.info("gemini ACP initialized")

    async def _read_loop(self) -> None:
        """stdout JSON-RPC 라인 파싱 → response 매칭 + notification 처리."""
        assert self._proc and self._proc.stdout
        while True:
            line = await self._proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError:
                continue
            # response (id 있음 + result/error)
            if "id" in msg and ("result" in msg or "error" in msg):
                fut = self._pending.pop(msg["id"], None)
                if fut and not fut.done():
                    if "error" in msg:
                        fut.set_exception(RuntimeError(str(msg["error"])))
                    else:
                        fut.set_result(msg.get("result"))
                continue
            # notification (method 있음, id 없음)
            method = msg.get("method")
            if method:
                self._on_notification(method, msg.get("params") or {})

    def _on_notification(self, method: str, params: dict) -> None:
        """ACP client notification 처리 — session/update agent 응답 수집."""
        if method == "session/update":
            update = params.get("update") or {}
            if update.get("sessionUpdate") == "agent_message_chunk":
                content = update.get("content") or {}
                # ContentBlock text variant
                if content.get("type") == "text":
                    text = content.get("text", "")
                    if text:
                        self._turn_messages.append(text)

    async def _request(self, method: str, params: dict | None) -> dict:
        """JSON-RPC request 송신 + response 대기."""
        assert self._proc and self._proc.stdin
        self._req_id += 1
        rid = self._req_id
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[rid] = fut
        payload = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            payload["params"] = params
        self._proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
        await self._proc.stdin.drain()
        return await fut

    async def ensure_session(self) -> str:
        """session/new (최초 1회) → sessionId 캐시.

        thread 매핑은 단일 session (후속 ef2603d8서 B 일괄 conversation→session 보강).
        """
        if self._session_id:
            return self._session_id
        result = await self._request("session/new", {
            "cwd": self._cwd,
            "mcpServers": [],
        })
        self._session_id = result.get("sessionId")
        if not self._session_id:
            raise RuntimeError(f"session/new returned no sessionId: {result}")
        logger.info("gemini session created: %s", self._session_id)
        return self._session_id

    async def run_turn(self, text: str) -> str:
        """session/prompt로 주입 → 응답(stopReason)까지 agent_message_chunk 수집.

        ACP는 session/prompt가 turn 완료(stopReason) 시점에 반환 →
        그때까지 수집된 agent_message_chunk를 응답으로 사용.
        """
        session_id = await self.ensure_session()
        self._turn_messages = []

        await self._request("session/prompt", {
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": text}],
        })
        # session/prompt 반환 = turn 완료 → 수집된 메시지 확정
        return "".join(self._turn_messages).strip()

    async def stop(self) -> None:
        """자식 프로세스 graceful 종료 (SIGTERM → kill). codex와 동형."""
        if self._reader_task:
            self._reader_task.cancel()
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
                await asyncio.wait_for(self._proc.wait(), timeout=5.0)
            except (asyncio.TimeoutError, ProcessLookupError):
                try:
                    self._proc.kill()
                except ProcessLookupError:
                    pass


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="[gemini-sprintable] %(levelname)s %(message)s",
        stream=sys.stderr,
    )
    api_url = (os.getenv("SPRINTABLE_API_URL", DEFAULT_API_URL) or DEFAULT_API_URL).rstrip("/")
    api_key = os.getenv("SPRINTABLE_API_KEY") or os.getenv("AGENT_API_KEY") or ""
    if not api_key:
        logger.error("SPRINTABLE_API_KEY or AGENT_API_KEY not set — host disabled")
        return

    gemini = GeminiAcpServer()
    await gemini.start()

    sse = SprintableSSEClient(api_url=api_url, api_key=api_key)

    async def inject(ctx: MessageContext) -> None:
        try:
            response = await gemini.run_turn(ctx.content)
        except Exception as exc:
            logger.warning("turn error conv=%s: %s", ctx.conversation_id, exc)
            return
        if response:
            await ctx.reply(response)

    try:
        await sse.run(inject)
    finally:
        await gemini.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
