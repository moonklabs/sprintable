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
        self._closed = False

    def push(self, obj: dict) -> None:
        self._queue.put_nowait((json.dumps(obj) + "\n").encode("utf-8"))

    def close(self) -> None:
        """#2439 QA(카디르) 재현용 — codex 프로세스가 죽어 stdout이 EOF되는 것을 흉내낸다."""
        self._closed = True
        self._queue.put_nowait(b"")  # 대기 중인 readline()을 즉시 깨움

    async def readline(self) -> bytes:
        if self._closed and self._queue.empty():
            return b""
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
                asyncio.get_running_loop().create_task(self._finish_active_turn())
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


class FakeCodexAppServerDiesMidTurn(FakeCodexAppServer):
    """#2439 QA(카디르) 재현 — turn/start 응답만 주고, completion/error «둘 다» 영원히 안 오는
    채로 stdout이 죽는다(codex 프로세스가 turn 도중 크래시하는 것과 동형)."""

    async def _finish_active_turn(self) -> None:
        await asyncio.sleep(self._turn_delay)
        # completion도 error도 안 보내고 그냥 프로세스가 죽는다 — stdout EOF.
        self.stdout.close()


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
async def test_process_death_mid_turn_fails_fast_not_hang(monkeypatch):
    """#2439 QA(카디르) 재현 — codex 프로세스가 turn 진행 중 죽으면(stdout EOF, completion도
    error도 다시는 안 옴) run_turn()이 그 자리서 즉시 실패해야 한다(hang 0).

    수정 전(read_loop이 EOF에 그냥 break만 하고 _pending_turns를 아무도 안 풂): hang — RED.
    수정 후(read_loop 종료 시 남은 pending turn 전부 fail-fast): 즉시 예외 — GREEN."""
    import host

    fake = FakeCodexAppServerDiesMidTurn(turn_delay=0.05)
    await _install_fake(monkeypatch, fake)

    codex = host.CodexAppServer(cwd="/tmp")
    await codex.start()
    try:
        task = asyncio.create_task(codex.run_turn("msg-death"))
        done, pending = await asyncio.wait({task}, timeout=2.0)
        assert not pending, "codex 프로세스가 turn 중 죽었는데 run_turn이 hang — orphan 회귀"
        with pytest.raises(Exception):
            await task
    finally:
        await codex.stop()


@pytest.mark.anyio
async def test_turn_id_routing_is_defense_in_depth_correct():
    """㉡ 카디르 QA 기록 — self._turn_lock이 겹침을 원천 차단하므로 정상 경로(run_turn 경유)
    에서는 turn_id map의 라우팅 분기가 도달 불가(unreachable)하다. 그래도 그 층 자체가 옳게
    동작하는지는 lock을 우회해 turn_id 두 개를 직접 등록·완료시켜 검증한다 — 방어적 설계가
    "무엇으로부터" 방어하는지 그 층만 따로 고정한다(향후 lock이 우회/약화돼도 이 층이 산다)."""
    import host

    codex = host.CodexAppServer(cwd="/tmp")
    fut_a: asyncio.Future = asyncio.get_running_loop().create_future()
    fut_b: asyncio.Future = asyncio.get_running_loop().create_future()
    codex._pending_turns["turn-A"] = fut_a
    codex._turn_texts["turn-A"] = []
    codex._pending_turns["turn-B"] = fut_b
    codex._turn_texts["turn-B"] = []

    codex._on_notification(
        "item/completed", {"item": {"type": "agentMessage", "text": "for-A"}, "turnId": "turn-A"},
    )
    codex._on_notification(
        "item/completed", {"item": {"type": "agentMessage", "text": "for-B"}, "turnId": "turn-B"},
    )
    codex._on_notification("turn/completed", {"turn": {"id": "turn-B"}})
    codex._on_notification("turn/completed", {"turn": {"id": "turn-A"}})

    assert await fut_a == ["for-A"], "turn-A 텍스트가 turn-B와 섞임 — turn_id 라우팅 회귀"
    assert await fut_b == ["for-B"], "turn-B 텍스트가 turn-A와 섞임 — turn_id 라우팅 회귀"


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
