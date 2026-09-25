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
# 까디르 QA(4683 CHANGES ①) — 예전 가드는 뿌리 이름(generate_text 등)에서만 번져, «SDK 메서드를 직접 부르는 **새** 동기 도우미 → 그걸 부르는
# async»(원래 결함 사슬 그대로)를 놓쳤다. 이제 두 겹:
#   (a) 등록: SDK 메서드(generate_content · embed_content …)를 **직접** 부르는 동기 함수는 BLOCKING_FUNCTIONS에 등록돼야 한다 — 등록 안 된
#       새 도우미면 RED(«막는 함수» 목록이 코드와 어긋나지 않게 · 반대로 등록됐는데 더는 직접 안 부르면 stale로 RED).
#   (b) 막음: async 안에서 막는 함수(등록 목록 + 그걸 부르는 동기 함수 · 고정점) 또는 SDK 메서드를 `asyncio.to_thread` 없이 부르면 RED.
SDK_METHODS = {"generate_content", "generate_content_stream", "embed_content", "count_tokens", "generate_images"}
# SDK를 직접 부르는 동기 함수(파일 · 함수) — 새 도우미를 만들면 여기 등록하고, async에선 to_thread로 부른다.
BLOCKING_FUNCTIONS = {
    ("services/llm_client.py", "generate_text"),
    ("services/embedding_client.py", "embed_text"),
}


def _call_name(node: ast.Call) -> str | None:
    f = node.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None


def _own_calls(fn: ast.AST):
    """fn 몸 안의 호출 — 안쪽 def/lambda(따로 도는 함수) 안은 빼고."""
    stack = list(ast.iter_child_nodes(fn))
    while stack:
        n = stack.pop()
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            continue
        if isinstance(n, ast.Call):
            yield n
        stack.extend(ast.iter_child_nodes(n))


def sdk_direct_sync_functions(trees: dict[Path, ast.Module]) -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for path, tree in trees.items():
        rel = path.relative_to(APP).as_posix()
        for fn in ast.walk(tree):
            if isinstance(fn, ast.FunctionDef) and any(_call_name(c) in SDK_METHODS for c in _own_calls(fn)):
                out.add((rel, fn.name))
    return out


def _blocking_names(trees: dict[Path, ast.Module], registered: set[tuple[str, str]]) -> set[str]:
    """막는 이름 — 등록된 SDK 직접 함수 + SDK 메서드 + 그걸(직접) 부르는 **동기** 함수 · 고정점까지(간접 사슬)."""
    names = {name for _, name in registered} | SDK_METHODS
    changed = True
    while changed:
        changed = False
        for tree in trees.values():
            for fn in ast.walk(tree):
                if isinstance(fn, ast.FunctionDef) and fn.name not in names and any(_call_name(c) in names for c in _own_calls(fn)):
                    names.add(fn.name)
                    changed = True
    return names


def find_blocking_calls_in_async(trees: dict[Path, ast.Module], registered: set[tuple[str, str]] | None = None) -> list[str]:
    names = _blocking_names(trees, BLOCKING_FUNCTIONS if registered is None else registered)
    hits: list[str] = []
    for path, tree in trees.items():
        for fn in ast.walk(tree):
            if not isinstance(fn, ast.AsyncFunctionDef):
                continue
            # asyncio.to_thread(f, …)의 f는 호출이 아니라 참조 — _own_calls는 Call만 보므로 따로 뺄 것이 없다.
            for c in _own_calls(fn):
                n = _call_name(c)
                if n in names:
                    hits.append(f"{path.relative_to(APP.parent)}:{c.lineno} {n} in async {fn.name}")
    return hits


def _parse(src: str) -> dict[Path, ast.Module]:
    return {APP / "x.py": ast.parse(src)}


def test_guard_positive_and_negative_controls():
    reg = {("x.py", "generate_text")}
    # 양성 — ⓐ async가 SDK 메서드 직접 · ⓑ async가 등록 함수 직접 · ⓒ **간접**: SDK를 직접 부르는 동기 도우미(등록 안 됨) → async가 그 도우미
    #        · ⓓ 두 단 간접(도우미 → 도우미 → SDK).
    assert find_blocking_calls_in_async(_parse("async def f(c):\n    return c.models.generate_content(model='m')\n"), reg)
    assert find_blocking_calls_in_async(_parse("async def f():\n    return generate_text('p')\n"), reg)
    assert find_blocking_calls_in_async(_parse(
        "def helper(c):\n    return c.models.generate_content(model='m')\n\nasync def f(c):\n    return helper(c)\n"), reg)
    assert find_blocking_calls_in_async(_parse(
        "def low(c):\n    return c.models.embed_content(model='m')\n\ndef mid(c):\n    return low(c)\n\nasync def f(c):\n    return mid(c)\n"), reg)
    # 음성 — to_thread로 넘김(등록 함수 · 간접 도우미 둘 다) · 동기 함수 안 · async에서 안 부름 · 안쪽 def 안(따로 도는 함수).
    assert not find_blocking_calls_in_async(_parse(
        "import asyncio\nasync def f():\n    return await asyncio.to_thread(generate_text, 'p')\n"), reg)
    assert not find_blocking_calls_in_async(_parse(
        "import asyncio\ndef helper(c):\n    return c.models.generate_content(model='m')\n\nasync def f(c):\n    return await asyncio.to_thread(helper, c)\n"), reg)
    assert not find_blocking_calls_in_async(_parse("def f():\n    return generate_text('p')\n"), reg)
    assert not find_blocking_calls_in_async(_parse(
        "async def f(c):\n    def job():\n        return c.models.generate_content(model='m')\n    return job\n"), reg)


def test_guard_registration_controls():
    # 등록 검사 — SDK를 직접 부르는 동기 함수는 찾아지고(양성) · async · 안쪽 def가 부르는 것은 «동기 도우미 등록» 대상이 아니다(음성).
    found = sdk_direct_sync_functions(_parse(
        "def helper(c):\n    return c.models.generate_content(model='m')\n\ndef other():\n    return 1\n"))
    assert found == {("x.py", "helper")}
    assert sdk_direct_sync_functions(_parse("async def f(c):\n    return c.models.generate_content(model='m')\n")) == set()


def _app_trees() -> dict[Path, ast.Module]:
    trees = {p: ast.parse(p.read_text()) for p in APP.rglob("*.py")}
    assert len(trees) > 200, "가드가 헛돈다(파일 수)"
    return trees


def test_guard_sdk_direct_functions_are_registered():
    """(a) SDK를 직접 부르는 동기 함수 = 등록 목록(새 도우미 미등록 · 등록만 남은 stale 둘 다 RED)."""
    found = sdk_direct_sync_functions(_app_trees())
    assert found == BLOCKING_FUNCTIONS, (
        f"미등록(새 SDK 직접 도우미 — BLOCKING_FUNCTIONS에 등록하고 async에선 to_thread로): {sorted(found - BLOCKING_FUNCTIONS)}\n"
        f"stale(더는 SDK를 직접 안 부름 — 목록에서 지울 것): {sorted(BLOCKING_FUNCTIONS - found)}"
    )


def test_guard_repo_has_no_blocking_llm_calls_in_async():
    hits = find_blocking_calls_in_async(_app_trees())
    assert hits == [], "async 안 동기 LLM/임베딩 호출(asyncio.to_thread로):\n" + "\n".join(hits)


@pytest.mark.parametrize("which", ["llm", "embed"])
def test_stalled_vertex_is_cut_at_our_timeout_and_lands_in_none_path(monkeypatch, caplog, which):
    """AC3 — «멈추는 가짜»(까디르 QA 4683 CHANGES ②: `pytest.raises(Exception)`은 검증 오류 · 연결 실패로도 초록이라 틀릴 수 없었다).
    연결을 받고 영영 답하지 않는 로컬 서버에 **우리 클라이언트**(generate_text · embed_text)를 붙인다 — 주소만 로컬로 바꾸고 timeout은
    우리 코드가 만든 HttpOptions 값을 그대로 쓴다. 단언: ⓐ 서버가 연결을 실제로 받았다(연결 실패로 초록 금지) ⓑ 경과가 제한 시각 근처
    ⓒ 떨어진 곳이 기존 None 처리 경로이고 거기 잡힌 예외가 **시간 초과**다. 제한을 빼면 서버가 놓아줄 때(3초)까지 멈춰 ⓑ · ⓒ가 RED."""
    import socket
    import threading

    import httpx
    from google import genai
    from google.genai import types

    from app.services import embedding_client, llm_client

    limit_ms = 300
    hold_s = 3.0
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    srv.settimeout(0.1)
    port = srv.getsockname()[1]
    accepted: list[float] = []
    stop = threading.Event()

    def serve():  # 연결을 받고 아무것도 안 보낸 채 붙잡는다(멈춘 Vertex) · 받은 수를 센다.
        while not stop.is_set():
            try:
                conn, _ = srv.accept()
            except OSError:
                continue
            accepted.append(time.monotonic())
            threading.Thread(target=lambda c=conn: (stop.wait(hold_s), c.close()), daemon=True).start()

    threading.Thread(target=serve, daemon=True).start()
    real_client = genai.Client

    def local_client(**kw):
        ours = kw["http_options"]  # 우리 코드가 만든 HttpOptions — timeout은 이 값 그대로.
        return real_client(api_key="test", http_options=types.HttpOptions(base_url=f"http://127.0.0.1:{port}", api_version=ours.api_version, timeout=ours.timeout))

    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "/dev/null")
    monkeypatch.setattr(genai, "Client", local_client)
    if which == "llm":
        monkeypatch.setattr(llm_client, "LLM_TIMEOUT_MS", limit_ms)
        mod, call = llm_client, lambda: llm_client.generate_text("p")
    else:
        monkeypatch.setattr(embedding_client, "EMBED_TIMEOUT_MS", limit_ms)
        mod, call = embedding_client, lambda: embedding_client.embed_text("t")

    caplog.set_level("WARNING", logger=mod.logger.name)
    try:
        start = time.monotonic()
        result = call()
        elapsed = time.monotonic() - start
    finally:
        stop.set()
        srv.close()

    assert result is None
    assert len(accepted) == 1, f"서버가 연결을 받지 않았다(또는 재시도 {len(accepted)}번) — 시간 초과가 아니라 연결 실패로 끝난 것일 수 있다"
    assert limit_ms / 1000 * 0.9 <= elapsed < limit_ms / 1000 + 1.5, f"제한({limit_ms}ms) 근처가 아니다({elapsed:.2f}s)"
    caught = [a for r in caplog.records if r.name == mod.logger.name for a in (r.args or ()) if isinstance(a, BaseException)]
    assert caught and isinstance(caught[-1], httpx.TimeoutException), f"None 처리 경로에 잡힌 예외가 시간 초과가 아니다: {caught!r}"
