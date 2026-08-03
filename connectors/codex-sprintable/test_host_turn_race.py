"""story #2439 — codex 커넥터 재진입 race(간헐 주입 실패, #2438 진단) 회귀 방지.

라이브 재현(2026-08-03, 디디, codex-cli 0.144.2)에서 실측한 정확한 서버 거동을 페이크
app-server로 재현한다: 이미 active인 turn 중에 새 turn/start가 오면 codex는 즉시 200으로
«가짜 turn»(다시는 안 나타나는 phantom turn_id)을 돌려주고, 실제 두 번째 메시지는 첫 번째
turn에 조용히 merge해 그 turn 하나의 turn/completed로만 끝낸다.

버그(수정 전 host.py): run_turn()이 self._turn_done(단일 Event)을 매 호출 통째 교체 →
재진입 시 첫 호출이 기다리던 옛 Event가 다시는 set되지 않아 영원히 hang.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _FakeWriter:
    def __init__(self, on_line) -> None:
        self._on_line = on_line
        self._buf = b""

    def write(self, data: bytes) -> None:
        self._buf += data
        while b"\n" in self._buf:
            line, self._buf = self._buf.split(b"\n", 1)
            if line:
                self._on_line(json.loads(line.decode("utf-8")))

    async def drain(self) -> None:
        return None


class _FakeReader:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()

    def push(self, obj: dict) -> None:
        self._queue.put_nowait((json.dumps(obj) + "\n").encode("utf-8"))

    async def readline(self) -> bytes:
        return await self._queue.get()


class FakeCodexAppServer:
    """실측(2026-08-03) 그대로: 겹쳐 들어온 turn/start는 phantom turn_id를 반환하고,
    실제 처리는 활성 turn에 merge — 그 turn 하나의 turn/completed로만 신호를 보낸다."""

    def __init__(self, *, turn_delay: float = 0.05) -> None:
        self.stdout = _FakeReader()
        self.stdin = _FakeWriter(self._on_line)
        self.stderr = _FakeReader()
        self.returncode: int | None = None
        self._turn_delay = turn_delay
        self._active_turn_id: str | None = None
        self._active_turn_texts: list[str] = []
        self._turn_seq = 0
        self._merged_calls = 0  # 겹쳐 merge된 횟수(뮤테이션/검증용 카운터)

    def _on_line(self, msg: dict) -> None:
        method = msg.get("method")
        rid = msg.get("id")
        if method == "initialize":
            self.stdout.push({"id": rid, "result": {}})
        elif method == "initialized":
            pass
        elif method == "thread/start":
            self.stdout.push({"id": rid, "result": {"thread": {"id": "thread-1"}}})
        elif method == "turn/start":
            text = msg["params"]["input"][0]["text"]
            if self._active_turn_id is None:
                # 새 turn — 정상 시작
                self._turn_seq += 1
                turn_id = f"turn-{self._turn_seq}"
                self._active_turn_id = turn_id
                self._active_turn_texts = [text]
                self.stdout.push({"id": rid, "result": {"turn": {"id": turn_id, "status": "inProgress"}}})
                asyncio.get_event_loop().create_task(self._finish_active_turn())
            else:
                # ⭐실측 재현: active turn 중 겹쳐 들어온 turn/start — phantom turn_id 반환,
                # 실제로는 활성 turn 텍스트 목록에 merge(다시는 이 phantom turn_id로 신호 없음).
                self._turn_seq += 1
                phantom_id = f"turn-{self._turn_seq}-phantom"
                self._active_turn_texts.append(text)
                self._merged_calls += 1
                self.stdout.push({"id": rid, "result": {"turn": {"id": phantom_id, "status": "inProgress"}}})

    async def _finish_active_turn(self) -> None:
        await asyncio.sleep(self._turn_delay)
        turn_id = self._active_turn_id
        texts = list(self._active_turn_texts)
        # merge된 각 텍스트마다 agentMessage 하나씩(실측처럼 순차 item/completed)
        for t in texts:
            self.stdout.push({
                "method": "item/completed",
                "params": {"item": {"type": "agentMessage", "text": f"echo:{t}"},
                           "threadId": "thread-1", "turnId": turn_id},
            })
        self.stdout.push({
            "method": "turn/completed",
            "params": {"threadId": "thread-1", "turn": {"id": turn_id, "status": "completed"}},
        })
        self._active_turn_id = None
        self._active_turn_texts = []

    async def wait(self):
        return 0

    def terminate(self):
        pass

    def kill(self):
        pass


async def _install_fake(monkeypatch, fake: FakeCodexAppServer):
    async def _fake_create_subprocess_exec(*args, **kwargs):
        return fake
    monkeypatch.setattr(asyncio, "create_subprocess_exec", _fake_create_subprocess_exec)


@pytest.mark.anyio
async def test_overlapping_run_turn_both_resolve_without_hang(monkeypatch):
    """핵심 회귀 테스트 — turn1이 아직 끝나기 전에 turn2를 겹쳐 호출해도 «둘 다» 유한 시간 내 반환.
    수정 전(버그 있음): 첫 호출이 옛 Event를 기다리다 절대 안 풀려 타임아웃(hang) — RED.
    수정 후: 직렬화(lock)로 codex 겹침 자체가 안 생기거나, turn_id map으로 각자 정확히 반환 — GREEN."""
    import host

    fake = FakeCodexAppServer(turn_delay=0.1)
    await _install_fake(monkeypatch, fake)

    codex = host.CodexAppServer(cwd="/tmp")
    await codex.start()
    try:
        t1 = asyncio.create_task(codex.run_turn("msg-A"))
        await asyncio.sleep(0.02)  # msg-A가 아직 active인 사이 msg-B 겹쳐 호출
        t2 = asyncio.create_task(codex.run_turn("msg-B"))

        done, pending = await asyncio.wait({t1, t2}, timeout=3.0)
        assert not pending, "겹쳐 호출한 run_turn 중 하나 이상이 hang(타임아웃) — orphan Event 회귀"

        r1, r2 = await t1, await t2
        assert r1 == "echo:msg-A", f"turn1 응답이 오염됨: {r1!r}"
        assert r2 == "echo:msg-B", f"turn2 응답이 오염됨: {r2!r}"
    finally:
        await codex.stop()


@pytest.mark.anyio
async def test_sequential_run_turn_unaffected(monkeypatch):
    """양성대조 — 겹치지 않는 정상 순차 호출은 무회귀."""
    import host

    fake = FakeCodexAppServer(turn_delay=0.05)
    await _install_fake(monkeypatch, fake)

    codex = host.CodexAppServer(cwd="/tmp")
    await codex.start()
    try:
        r1 = await codex.run_turn("one")
        r2 = await codex.run_turn("two")
        assert r1 == "echo:one"
        assert r2 == "echo:two"
    finally:
        await codex.stop()
