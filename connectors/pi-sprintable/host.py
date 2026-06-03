"""Sprintable Gateway adapter host for Pi — E-INJECT-ADAPTERS (카테고리 B).

카테고리 B 셋째 — codex/gemini 호스트와 동형 골격.
차이 = 메시지 레이어: pi는 `pi --mode rpc` (JSONL/stdio — JSON-RPC 아닌 줄단위 JSON).
명령은 stdin JSONL, 이벤트/응답은 stdout JSONL.

구조 (codex/gemini와 동일):
  - 공통 SDK(connectors/sdk/sprintable_sse.py) 재사용 — SSE 소비·dedup·ack·backoff
  - pi --mode rpc (JSONL/stdio)를 spawn/own
  - SSE 이벤트마다 {"type":"prompt", message} 주입 (steer로 mid-stream 가능)
  - agent_end 이벤트의 assistant 메시지 텍스트 수집 → 응답 확정
  - 응답 → ctx.reply() → POST /api/v2/conversations/{id}/messages

실측 스키마 (@earendil-works/pi-coding-agent@0.78.0, dist/modes/rpc/rpc-types.d.ts):
  RpcCommand: {type:"prompt", message, streamingBehavior?:"steer"|"followUp"}
              {type:"steer", message}  — mid-stream 주입 (pi 강점)
  stdout JSONL: RpcResponse {type:"response", command:"prompt", success} = ack
                AgentSessionEvent (session.subscribe) — agent_end {messages:[AgentMessage]}
  AgentMessage(assistant).content: (TextContent{type:"text",text} | ...)
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

logger = logging.getLogger("pi-sprintable")

PI_BIN = os.getenv("PI_BIN", "pi")
DEFAULT_API_URL = "https://sprintable-backend-dev-57iommnikq-du.a.run.app"


class PiRpcServer:
    """pi --mode rpc JSONL/stdio 자식 프로세스 호스트.

    한 번 spawn해서 lifetime 동안 own. shutdown 시 SIGTERM→kill.
    codex/gemini host와 동형 — 메시지 레이어만 JSONL로 교체.
    """

    def __init__(self, cwd: str | None = None) -> None:
        self._cwd = cwd or os.getcwd()
        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        # turn 응답 수집: agent_end 의 assistant 텍스트
        self._turn_messages: list[str] = []
        self._turn_done: asyncio.Event | None = None

    async def start(self) -> None:
        """pi --mode rpc spawn. (JSONL은 별도 initialize 핸드셰이크 없음)"""
        self._proc = await asyncio.create_subprocess_exec(
            PI_BIN, "--mode", "rpc",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._cwd,
        )
        self._reader_task = asyncio.create_task(self._read_loop())
        logger.info("pi --mode rpc started")

    async def _read_loop(self) -> None:
        """stdout JSONL 라인 파싱 → 이벤트/응답 처리."""
        assert self._proc and self._proc.stdout
        while True:
            line = await self._proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError:
                continue
            self._on_message(msg)

    def _on_message(self, msg: dict) -> None:
        """JSONL stdout 메시지 처리.

        - AgentSessionEvent: agent_end {messages} → assistant 텍스트 수집 + turn 완료
        - RpcResponse {type:"response"}: ack (별도 처리 불필요)
        """
        mtype = msg.get("type")
        if mtype == "agent_end":
            for am in msg.get("messages") or []:
                if am.get("role") == "assistant":
                    for block in am.get("content") or []:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text = block.get("text", "")
                            if text:
                                self._turn_messages.append(text)
            if self._turn_done and not self._turn_done.is_set():
                self._turn_done.set()

    async def _send(self, cmd: dict) -> None:
        """JSONL 명령 stdin 송신."""
        assert self._proc and self._proc.stdin
        self._proc.stdin.write((json.dumps(cmd) + "\n").encode("utf-8"))
        await self._proc.stdin.drain()

    async def run_turn(self, text: str) -> str:
        """{type:"prompt", message} 주입 → agent_end까지 assistant 텍스트 수집.

        thread 매핑은 단일 세션 (후속 ef2603d8서 B 일괄 보강).
        """
        self._turn_messages = []
        self._turn_done = asyncio.Event()

        await self._send({"type": "prompt", "message": text})
        # agent_end 대기 (turn 완료 + 응답 수집)
        await self._turn_done.wait()
        return "".join(self._turn_messages).strip()

    async def stop(self) -> None:
        """자식 프로세스 graceful 종료 (SIGTERM → kill). codex/gemini 동형."""
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
        format="[pi-sprintable] %(levelname)s %(message)s",
        stream=sys.stderr,
    )
    api_url = (os.getenv("SPRINTABLE_API_URL", DEFAULT_API_URL) or DEFAULT_API_URL).rstrip("/")
    api_key = os.getenv("SPRINTABLE_API_KEY") or os.getenv("AGENT_API_KEY") or ""
    if not api_key:
        logger.error("SPRINTABLE_API_KEY or AGENT_API_KEY not set — host disabled")
        return

    pi = PiRpcServer()
    await pi.start()

    sse = SprintableSSEClient(api_url=api_url, api_key=api_key)

    async def inject(ctx: MessageContext) -> None:
        try:
            response = await pi.run_turn(ctx.content)
        except Exception as exc:
            logger.warning("turn error conv=%s: %s", ctx.conversation_id, exc)
            return
        if response:
            await ctx.reply(response)

    try:
        await sse.run(inject)
    finally:
        await pi.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
