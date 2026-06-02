"""Sprintable Gateway adapter host for Codex — E-INJECT-ADAPTERS (카테고리 B).

카테고리 B 첫 어댑터 — stdio JSON-RPC 자식 프로세스 호스트 패턴 확립.
gemini/pi/grok이 이 패턴을 동형으로 따라간다.

구조:
  - 공통 SDK(connectors/sdk/sprintable_sse.py) 재사용 — SSE 소비·dedup·ack·backoff
  - codex app-server (JSON-RPC/stdio)를 spawn/own
  - SSE 이벤트마다 thread/start(최초) + turn/start로 turn 주입
  - item/completed(agentMessage) 스트림 수집 → turn/completed에서 응답 확정
  - 응답 → ctx.reply() → POST /api/v2/conversations/{id}/messages

실측 프로토콜 (codex app-server generate-ts, codex-cli 0.124.0):
  initialize → initialized(notify) → thread/start → turn/start
  ServerNotification: item/completed {item:{type:"agentMessage",text}}, turn/completed
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

logger = logging.getLogger("codex-sprintable")

CODEX_BIN = os.getenv("CODEX_BIN", "codex")
DEFAULT_API_URL = "https://sprintable-backend-dev-57iommnikq-du.a.run.app"


class CodexAppServer:
    """codex app-server JSON-RPC/stdio 자식 프로세스 호스트.

    한 번 spawn해서 lifetime 동안 own. AbortSignal/shutdown 시 SIGTERM.
    """

    def __init__(self, cwd: str | None = None) -> None:
        self._cwd = cwd or os.getcwd()
        self._proc: asyncio.subprocess.Process | None = None
        self._req_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        # turn 응답 수집: turn 진행 중 agentMessage 텍스트 누적
        self._turn_messages: list[str] = []
        self._turn_done: asyncio.Event | None = None
        self._reader_task: asyncio.Task | None = None
        self._thread_id: str | None = None

    async def start(self) -> None:
        """codex app-server spawn + initialize 핸드셰이크."""
        self._proc = await asyncio.create_subprocess_exec(
            CODEX_BIN, "app-server",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._cwd,
        )
        self._reader_task = asyncio.create_task(self._read_loop())

        # initialize 핸드셰이크
        await self._request("initialize", {
            "clientInfo": {
                "name": "sprintable-codex-adapter",
                "title": "Sprintable Gateway",
                "version": "0.1.0",
            },
            "capabilities": None,
        })
        await self._notify("initialized", None)
        logger.info("codex app-server initialized")

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
        """ServerNotification 처리 — turn 응답 수집."""
        if method == "item/completed":
            item = params.get("item") or {}
            if item.get("type") == "agentMessage":
                text = item.get("text", "")
                if text:
                    self._turn_messages.append(text)
        elif method == "turn/completed":
            if self._turn_done and not self._turn_done.is_set():
                self._turn_done.set()
        elif method == "error":
            logger.warning("codex error notification: %s", params)
            if self._turn_done and not self._turn_done.is_set():
                self._turn_done.set()

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

    async def _notify(self, method: str, params: dict | None) -> None:
        """JSON-RPC notification 송신 (response 없음)."""
        assert self._proc and self._proc.stdin
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        self._proc.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
        await self._proc.stdin.drain()

    async def ensure_thread(self) -> str:
        """thread/start (최초 1회) → thread_id 캐시."""
        if self._thread_id:
            return self._thread_id
        result = await self._request("thread/start", {
            "experimentalRawEvents": False,
            "persistExtendedHistory": False,
        })
        thread = result.get("thread") or {}
        self._thread_id = thread.get("id")
        if not self._thread_id:
            raise RuntimeError(f"thread/start returned no id: {result}")
        logger.info("codex thread started: %s", self._thread_id)
        return self._thread_id

    async def run_turn(self, text: str) -> str:
        """turn/start로 주입 → turn/completed까지 agentMessage 수집 → 응답 반환."""
        thread_id = await self.ensure_thread()
        self._turn_messages = []
        self._turn_done = asyncio.Event()

        await self._request("turn/start", {
            "threadId": thread_id,
            "input": [{"type": "text", "text": text, "text_elements": []}],
        })
        # turn/completed 대기 (응답 스트림 수집 완료)
        await self._turn_done.wait()
        return "\n".join(self._turn_messages).strip()

    async def stop(self) -> None:
        """자식 프로세스 graceful 종료 (SIGTERM → kill)."""
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
        format="[codex-sprintable] %(levelname)s %(message)s",
        stream=sys.stderr,
    )
    api_url = (os.getenv("SPRINTABLE_API_URL", DEFAULT_API_URL) or DEFAULT_API_URL).rstrip("/")
    api_key = os.getenv("SPRINTABLE_API_KEY") or os.getenv("AGENT_API_KEY") or ""
    if not api_key:
        logger.error("SPRINTABLE_API_KEY or AGENT_API_KEY not set — host disabled")
        return

    codex = CodexAppServer()
    await codex.start()

    sse = SprintableSSEClient(api_url=api_url, api_key=api_key)

    async def inject(ctx: MessageContext) -> None:
        try:
            response = await codex.run_turn(ctx.content)
        except Exception as exc:
            logger.warning("turn error conv=%s: %s", ctx.conversation_id, exc)
            return
        if response:
            await ctx.reply(response)

    try:
        await sse.run(inject)
    finally:
        await codex.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
