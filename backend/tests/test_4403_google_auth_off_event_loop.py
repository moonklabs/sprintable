"""story #4403 AC1b — 동기 google-auth 네트워크 호출(`id_token.verify_oauth2_token` · `credentials.refresh` · `fetch_id_token` ·
Secret Manager — google-auth 기본 timeout 120s)을 async 함수 안에서 맨으로 부르면 그동안 **이벤트 루프 전체**가 멈춘다.
`await asyncio.to_thread(...)`로 옮긴 뒤엔 느린 가짜 호출 동안에도 같은 루프의 다른 코루틴이 진행된다.

- 행동: 관리자 인증(요청마다 인증서 조회) · Firebase 세션쿠키 발급(ADC 토큰 갱신) — 느린 가짜 동안 ticker가 계속 돎.
- 구조: 고친 다섯 파일의 async 함수 안에 동기 헬퍼 맨 호출 0(나머지 자리는 이것이 지킨다).
뮤테이션: 한 자리라도 맨 호출로 되돌리면 RED.
"""
from __future__ import annotations

import ast
import time
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
import pytest

_SLOW_SECONDS = 0.6
_TICK_SECONDS = 0.05
# 막히지 않으면 0.6s / 0.05s ≈ 12번. 막히면 느린 호출 동안 0 · 앞뒤로 1~2번. 넉넉히 절반 이상을 요구한다.
_MIN_TICKS = int(_SLOW_SECONDS / _TICK_SECONDS / 2)


async def _ticks_while(coro):
    """coro가 도는 동안 같은 루프에서 ticker가 몇 번 똑딱였는지(루프가 막히면 거의 0)."""
    import asyncio

    ticks = 0
    stop = asyncio.Event()

    async def ticker() -> None:
        nonlocal ticks
        while not stop.is_set():
            await asyncio.sleep(_TICK_SECONDS)
            ticks += 1

    t = asyncio.create_task(ticker())
    await asyncio.sleep(0)
    before = ticks
    try:
        result = await coro
    finally:
        stop.set()
        await t
    return ticks - before, result


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_admin_operator_token_verify_does_not_block_the_loop(monkeypatch):
    import app.dependencies.admin_auth as admin_auth
    from app.core.config import settings

    monkeypatch.setattr(settings, "admin_operator_audience", "https://aud.example")
    monkeypatch.setattr(settings, "admin_operator_allowlist", "op@example.com")

    def _slow_verify(token, request, audience=None):
        time.sleep(_SLOW_SECONDS)  # 인증서 조회 흉내
        return {"email": "op@example.com", "sub": "123", "email_verified": True}

    monkeypatch.setattr(admin_auth.id_token, "verify_oauth2_token", _slow_verify)
    ticks, operator = await _ticks_while(admin_auth.require_admin_operator(authorization="Bearer t"))
    assert operator.email == "op@example.com"
    assert ticks >= _MIN_TICKS, ticks


@pytest.mark.anyio
async def test_firebase_session_mint_access_token_does_not_block_the_loop(monkeypatch):
    import app.services.firebase_session_mint as mint

    def _slow_token():
        time.sleep(_SLOW_SECONDS)  # ADC credentials.refresh 흉내
        return "access-token"

    monkeypatch.setattr(mint, "_get_access_token", _slow_token)
    ok = httpx.Response(200, json={"sessionCookie": "cookie-value"}, request=httpx.Request("POST", "https://x"))
    with patch.object(mint, "_call_create_session_cookie", AsyncMock(return_value=ok)):
        ticks, cookie = await _ticks_while(mint.mint_session_cookie("id-token", "proj"))
    assert cookie == "cookie-value"
    assert ticks >= _MIN_TICKS, ticks


# ── 구조 ──

_FILES_AND_HELPERS = {
    "app/dependencies/admin_auth.py": {"verify_oauth2_token"},
    "app/services/firebase_session_mint.py": {"_get_access_token", "mint_custom_token"},
    "app/services/play_integrity.py": {"_get_access_token"},
    "app/services/github_app.py": {"build_app_jwt"},
    "app/services/office_conversion.py": {"_id_token_header"},
}


def _bare_calls_in_async(path: Path, names: set[str]) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found: list[str] = []

    class V(ast.NodeVisitor):
        def __init__(self) -> None:
            self.stack: list[str] = []

        def visit_AsyncFunctionDef(self, n):  # noqa: N802
            self.stack.append("async")
            self.generic_visit(n)
            self.stack.pop()

        def visit_FunctionDef(self, n):  # noqa: N802
            self.stack.append("sync")
            self.generic_visit(n)
            self.stack.pop()

        def visit_Lambda(self, n):  # noqa: N802
            self.stack.append("sync")
            self.generic_visit(n)
            self.stack.pop()

        def visit_Call(self, n):  # noqa: N802
            f = n.func
            name = f.id if isinstance(f, ast.Name) else (f.attr if isinstance(f, ast.Attribute) else None)
            if self.stack and self.stack[-1] == "async" and name in names:
                found.append(f"{path.name}:{n.lineno} {name}")
            self.generic_visit(n)

    V().visit(tree)
    return found


def test_no_bare_sync_google_auth_call_inside_async_functions():
    root = Path(__file__).resolve().parents[1]
    offenders = [hit for rel, names in _FILES_AND_HELPERS.items() for hit in _bare_calls_in_async(root / rel, names)]
    assert offenders == [], offenders


def test_the_structural_check_would_catch_a_bare_call():
    """양성 대조: 구조 검사 자체가 맨 호출을 실제로 잡는다(항상 빈 목록을 돌려주는 헛검사가 아님)."""
    import tempfile

    src = "async def f():\n    return _get_access_token()\n"
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as fh:
        fh.write(src)
    assert _bare_calls_in_async(Path(fh.name), {"_get_access_token"}) != []
