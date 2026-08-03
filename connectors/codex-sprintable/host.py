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

story #2439(2026-08-03, #2438 진단의 근본수정) — 재진입(겹침) race 제거:
  turn/start 호출을 self._turn_lock(asyncio.Lock)으로 직렬화해 «이전 turn이 아직 active인
  동안 새 turn/start를 codex에 절대 보내지 않는다» — 겹침 자체가 안 생기므로 codex가
  겹친 turn/start에 내주는 phantom turn(응답은 오지만 다시는 완료 신호가 없는 turn_id, 라이브
  실측 확認)이 발생할 여지가 없다. 방어적으로 완료 라우팅도 turn_id 키 pending-map으로 바꿔
  (기존의 단일 self._turn_done Event 통째-교체 방식은 재진입 시 첫 호출이 기다리던 옛 Event가
  다시는 set되지 않아 영원히 hang했다 — 정확히 #2438이 재현한 "간헐적 자동주입 실패") 설령
  어떤 경로로든 두 turn이 겹치더라도 각 run_turn()이 "자기 turn_id"의 완료만 기다리게 한다.
  타임아웃/재시도로 덮지 않음 — orphan 자체가 구조적으로 불가능해야 한다는 원칙.
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
        # turn_id → (완료 Future, 그 turn의 agentMessage 텍스트 누적) — #2439: 겹침이 생겨도
        # 각 run_turn()이 «자기 turn_id»의 완료만 기다리도록 turn_id로 라우팅한다.
        self._pending_turns: dict[str, asyncio.Future] = {}
        self._turn_texts: dict[str, list[str]] = {}
        # #2439: turn/start를 직렬화 — 이전 turn이 아직 active인 동안 새 turn/start를 codex에
        # 절대 보내지 않는다(라이브 실측: 겹치면 codex가 phantom turn을 내주고 실제 처리는
        # 기존 turn에 merge — 겹침 자체를 없애는 것이 근본 처방).
        self._turn_lock = asyncio.Lock()
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
        """ServerNotification 처리 — turn_id로 올바른 run_turn() 호출에 라우팅(#2439)."""
        if method == "item/completed":
            item = params.get("item") or {}
            if item.get("type") == "agentMessage":
                text = item.get("text", "")
                turn_id = params.get("turnId")
                if text and turn_id in self._turn_texts:
                    self._turn_texts[turn_id].append(text)
        elif method == "turn/completed":
            turn = params.get("turn") or {}
            turn_id = turn.get("id")
            fut = self._pending_turns.pop(turn_id, None)
            if fut and not fut.done():
                fut.set_result(list(self._turn_texts.pop(turn_id, [])))
        elif method == "error":
            logger.warning("codex error notification: %s", params)
            # threadId/turnId가 없는 전역 에러 — 지금 대기 중인 모든 turn을 fail-fast로
            # 풀어준다(#2438과 같은 결의 재발 방지 — "아무 신호도 안 와서 hang"을 만들지 않음).
            turn_id = params.get("turnId") or (params.get("turn") or {}).get("id")
            if turn_id:
                fut = self._pending_turns.pop(turn_id, None)
                if fut and not fut.done():
                    fut.set_exception(RuntimeError(f"codex error: {params}"))
            else:
                for pending_id, fut in list(self._pending_turns.items()):
                    if not fut.done():
                        fut.set_exception(RuntimeError(f"codex error (no turnId): {params}"))
                    self._pending_turns.pop(pending_id, None)
                    self._turn_texts.pop(pending_id, None)

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
        """turn/start로 주입 → «자기 turn_id»의 turn/completed까지 agentMessage 수집 → 응답 반환.

        #2439: self._turn_lock으로 직렬화 — 이전 turn이 아직 active인 동안은 이 turn/start
        자체가 codex로 안 나간다(겹침 발생 원천 차단). 그 위에 turn_id 키 pending-map으로
        완료 신호도 정확히 "자기 turn"만 받게 해 이중으로 막는다(설령 겹침이 다른 경로로
        생겨도 orphan 없음).
        """
        thread_id = await self.ensure_thread()
        async with self._turn_lock:
            result = await self._request("turn/start", {
                "threadId": thread_id,
                "input": [{"type": "text", "text": text, "text_elements": []}],
            })
            turn = (result or {}).get("turn") or {}
            turn_id = turn.get("id")
            if not turn_id:
                raise RuntimeError(f"turn/start returned no turn id: {result}")

            fut: asyncio.Future = asyncio.get_event_loop().create_future()
            self._pending_turns[turn_id] = fut
            self._turn_texts[turn_id] = []
            try:
                texts = await fut
            finally:
                # 타임아웃/취소 등 어떤 경로로 빠져나가도 맵에 orphan 항목이 안 남게 정리.
                self._pending_turns.pop(turn_id, None)
                self._turn_texts.pop(turn_id, None)
            return "\n".join(texts).strip()

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
