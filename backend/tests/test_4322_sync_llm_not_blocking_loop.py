"""story #4322 — 동기 Vertex SDK 호출(`llm_client.generate_text` · `embedding_client.embed_text`)을 async 흐름에서 직접 부르면
그 호출 동안 이벤트 루프가 막혀 같은 인스턴스의 다른 요청이 모두 기다린다. Vertex가 멈추면(예전엔 명시 timeout 없음) 워커가 멈춘다.

①  루프 안 막힘(AC2): 느린 가짜 생성(time.sleep) 동안 다른 코루틴이 계속 돈다 — 스레드로 넘기지 않으면 틱이 0에 가깝다.
②  명시 시간 제한: 두 클라이언트가 HttpOptions.timeout을 싣고, 시간 초과 예외는 None(«아직 못 만듦»)으로 수렴한다.
③  가드: async 함수 안에서 동기 LLM/임베딩 호출(또는 그걸 부르는 동기 도우미)을 `asyncio.to_thread` 없이 부르면 FAIL.
"""
from __future__ import annotations

import ast
import asyncio
import json
import time
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parent.parent / "app"
SLOW_S = 0.4


async def _ticks_while(coro) -> tuple[object, int]:
    ticks = 0
    done = False

    async def ticker():
        nonlocal ticks
        while not done:
            await asyncio.sleep(0.01)
            ticks += 1

    t = asyncio.create_task(ticker())
    await asyncio.sleep(0)  # 틱커가 먼저 한 번 돌게
    try:
        result = await coro
    finally:
        done = True
        await t
    return result, ticks


@pytest.mark.anyio
async def test_recommend_next_does_not_block_event_loop(monkeypatch):
    """① 느린 가짜 generate_text(0.4초 · 동기 sleep) 동안 다른 코루틴이 10ms마다 계속 돈다(예전 직접 호출이면 거의 0틱)."""
    from app.services import llm_client, retro_synthesis

    def slow_generate(prompt, **kwargs):
        time.sleep(SLOW_S)
        return json.dumps({"items": [{"statement": "다음 가설", "rationale": "근거", "confidence": 0.5}]})

    monkeypatch.setattr(llm_client, "generate_text", slow_generate)
    synthesis = {"learned": [{"text": "배운 것 하나"}]}
    result, ticks = await _ticks_while(retro_synthesis.recommend_next(synthesis))
    assert result, "LLM을 실제로 불렀어야(빈 프롬프트면 즉시 반환해 루프 검사가 헛돈다)"
    # 0.4초 동안 10ms 틱이면 이상적으로 ~40 — 여유를 두고 절반 이상.
    assert ticks >= int(SLOW_S / 0.01 / 2), f"이벤트 루프가 막혔다(틱 {ticks})"


class _FakeModels:
    def __init__(self, exc):
        self._exc = exc

    def generate_content(self, **kwargs):
        raise self._exc

    def embed_content(self, **kwargs):
        raise self._exc


class _FakeClient:
    seen: list = []

    def __init__(self, *, exc, **kwargs):
        _FakeClient.seen.append(kwargs.get("http_options"))
        self.models = _FakeModels(exc)


@pytest.mark.parametrize("which", ["llm", "embed"])
def test_clients_carry_explicit_timeout_and_timeout_is_none(monkeypatch, which):
    """② HttpOptions.timeout(밀리초)이 실리고 · 시간 초과 예외는 예외 전파 없이 None."""
    import httpx
    from google import genai

    from app.services import embedding_client, llm_client

    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "/dev/null")
    _FakeClient.seen = []
    monkeypatch.setattr(genai, "Client", lambda **kw: _FakeClient(exc=httpx.ReadTimeout("stalled"), **kw))
    if which == "llm":
        assert llm_client.generate_text("프롬프트") is None
        assert _FakeClient.seen[-1].timeout == llm_client.LLM_TIMEOUT_MS
    else:
        assert embedding_client.embed_text("문장") is None
        assert _FakeClient.seen[-1].timeout == embedding_client.EMBED_TIMEOUT_MS


def test_llm_timeout_is_shorter_than_browser_and_bff_limit():
    """25초 < 브라우저 · BFF 30초(4310 · 4320) — 사용자가 끊기 전에 None으로 돌아온다."""
    from app.services import llm_client

    assert llm_client.LLM_TIMEOUT_MS < 30_000


# ── ③ 가드 ────────────────────────────────────────────────────────────────────
BLOCKING_ROOTS = {"generate_text", "embed_text", "embed_texts"}
BLOCKING_METHODS = {"generate_content", "embed_content"}


def _call_name(node: ast.Call) -> str | None:
    f = node.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None


def _blocking_names(trees: dict[Path, ast.Module]) -> set[str]:
    """동기 LLM 뿌리 + 그걸(직접) 부르는 **동기** 함수 이름 — 고정점까지."""
    names = set(BLOCKING_ROOTS)
    changed = True
    while changed:
        changed = False
        for tree in trees.values():
            for fn in ast.walk(tree):
                if isinstance(fn, ast.FunctionDef) and fn.name not in names:
                    if any(isinstance(c, ast.Call) and _call_name(c) in names for c in ast.walk(fn)):
                        names.add(fn.name)
                        changed = True
    return names


def _to_thread_args(fn: ast.AsyncFunctionDef) -> set[int]:
    """asyncio.to_thread(f, …)의 첫 인자로 넘긴 이름 노드 id — 호출이 아니라 참조라 막지 않는다."""
    out: set[int] = set()
    for c in ast.walk(fn):
        if isinstance(c, ast.Call) and _call_name(c) == "to_thread":
            out.update(id(a) for a in c.args[:1])
    return out


def find_blocking_calls_in_async(trees: dict[Path, ast.Module]) -> list[str]:
    names = _blocking_names(trees)
    hits: list[str] = []
    for path, tree in trees.items():
        for fn in ast.walk(tree):
            if not isinstance(fn, ast.AsyncFunctionDef):
                continue
            for c in ast.walk(fn):
                # 안쪽 동기 함수(중첩 def) 안의 호출은 그 함수 몫.
                if not isinstance(c, ast.Call):
                    continue
                inner = [d for d in ast.walk(fn) if isinstance(d, (ast.FunctionDef, ast.Lambda)) and any(x is c for x in ast.walk(d))]
                if inner:
                    continue
                n = _call_name(c)
                if n in names or n in BLOCKING_METHODS:
                    hits.append(f"{path.relative_to(APP.parent)}:{c.lineno} {n} in async {fn.name}")
    return hits


def _parse(src: str) -> dict[Path, ast.Module]:
    return {APP / "x.py": ast.parse(src)}


def test_guard_positive_and_negative_controls():
    # 양성 — async에서 직접 · 동기 도우미 경유 · SDK 메서드 직접.
    assert find_blocking_calls_in_async(_parse("async def f():\n    return generate_text('p')\n"))
    assert find_blocking_calls_in_async(_parse(
        "def helper(x):\n    return generate_text(x)\n\nasync def f():\n    return helper('p')\n"))
    assert find_blocking_calls_in_async(_parse("async def f(c):\n    return c.models.generate_content(model='m')\n"))
    # 음성 — to_thread로 넘김 · 동기 함수 안 · async에서 안 부름.
    assert not find_blocking_calls_in_async(_parse(
        "import asyncio\nasync def f():\n    return await asyncio.to_thread(generate_text, 'p')\n"))
    assert not find_blocking_calls_in_async(_parse(
        "def helper(x):\n    return generate_text(x)\n\nasync def f():\n    import asyncio\n    return await asyncio.to_thread(helper, 'p')\n"))
    assert not find_blocking_calls_in_async(_parse("def f():\n    return generate_text('p')\n"))


def test_guard_repo_has_no_blocking_llm_calls_in_async():
    trees = {p: ast.parse(p.read_text()) for p in APP.rglob("*.py")}
    assert len(trees) > 200, "가드가 헛돈다(파일 수)"
    hits = find_blocking_calls_in_async(trees)
    assert hits == [], "async 안 동기 LLM/임베딩 호출(asyncio.to_thread로):\n" + "\n".join(hits)


def test_sdk_actually_enforces_http_options_timeout():
    """AC3 — «멈추는 가짜»: 응답을 영영 안 보내는 로컬 HTTP 서버에 google-genai SDK를 붙이면, HttpOptions.timeout(밀리초)에서
    끊긴다(우리 클라이언트가 그 값을 싣는 건 위 테스트가 고정). timeout을 안 주면 이 호출은 서버가 답할 때까지 멈춘다."""
    import socket
    import threading

    from google import genai
    from google.genai import types

    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    stop = threading.Event()

    def hold():  # 연결을 받고 아무것도 안 보낸 채 붙잡는다(멈춘 Vertex).
        conn, _ = srv.accept()
        stop.wait(10)
        conn.close()

    threading.Thread(target=hold, daemon=True).start()
    client = genai.Client(api_key="test", http_options=types.HttpOptions(base_url=f"http://127.0.0.1:{port}", timeout=300))
    start = time.monotonic()
    with pytest.raises(Exception):
        client.models.generate_content(model="m", contents="p")
    elapsed = time.monotonic() - start
    stop.set()
    srv.close()
    assert elapsed < 3, f"SDK가 timeout(0.3초)에 끊지 않았다({elapsed:.2f}s)"
