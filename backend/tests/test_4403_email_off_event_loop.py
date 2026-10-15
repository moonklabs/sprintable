"""story #4403 — 동기 `send_email`(SMTP 10s · Resend 30s)을 async 함수 안에서 맨으로 부르면 발송 동안 **워커의 이벤트 루프 전체**가 멈춘다.
`await asyncio.to_thread(...)`로 옮긴 뒤엔, 느린 가짜 발송(동기 sleep) 동안에도 같은 루프의 다른 코루틴이 진행된다.

- 행동: 느린 가짜 send_email 동안 같은 루프의 ticker가 계속 똑딱인다(막히면 발송 시간 동안 0).
- 구조: 이 카드가 고친 파일들의 async 함수 안에 `send_email` · `send_invite_email` 맨 호출이 0(org_invites는 핸들러의 나머지
  DB 경로 세팅이 커서 행동 테스트 대신 이 구조 테스트가 지킨다).
뮤테이션: 한 자리라도 맨 호출로 되돌리면 그 자리의 행동 테스트 · 구조 테스트가 RED.
"""
from __future__ import annotations

import ast
import asyncio
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_SLOW_SECONDS = 0.6
_TICK_SECONDS = 0.05


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _slow_send(*_a, **_kw) -> bool:
    time.sleep(_SLOW_SECONDS)  # 동기 발송 흉내 — 루프 스레드에서 돌면 루프가 이만큼 멈춘다
    return True


async def _ticks_while(coro) -> tuple[int, object]:
    """coro가 도는 동안 같은 루프에서 ticker가 몇 번 똑딱였는지(루프가 막히면 거의 0)."""
    ticks = 0
    stop = asyncio.Event()

    async def ticker() -> None:
        nonlocal ticks
        while not stop.is_set():
            await asyncio.sleep(_TICK_SECONDS)
            ticks += 1

    t = asyncio.create_task(ticker())
    await asyncio.sleep(0)  # ticker가 먼저 한 번 돌게
    before = ticks
    try:
        result = await coro
    finally:
        stop.set()
        await t
    return ticks - before, result


# 막히지 않으면 0.6s / 0.05s ≈ 12번. 막히면 발송 동안 0 · 앞뒤로 1~2번. 넉넉히 절반 이상을 요구한다.
_MIN_TICKS = int(_SLOW_SECONDS / _TICK_SECONDS / 2)


@pytest.mark.anyio
async def test_onboarding_reminder_does_not_block_the_loop():
    from app.services.onboarding_activation import send_activation_reminder

    user = SimpleNamespace(id=uuid.uuid4(), email="a@example.com", locale="ko", onboarding_reminder_sent_at=None)
    with patch("app.services.email.send_email", side_effect=_slow_send):
        ticks, delivered = await _ticks_while(send_activation_reminder(MagicMock(), user))
    assert delivered is True
    assert ticks >= _MIN_TICKS, ticks


@pytest.mark.anyio
async def test_set_password_request_does_not_block_the_loop():
    """요청 경로(async 핸들러) — 느린 발송 동안 루프가 다른 일을 한다."""
    from app.dependencies.auth import get_current_user
    from tests.test_auth_10_backend import _client, _make_auth_ctx, _make_oauth_user

    client, session, app = await _client()
    try:
        user = _make_oauth_user()
        ctx = _make_auth_ctx(user.id)
        app.dependency_overrides[get_current_user] = lambda: ctx
        with patch("app.routers.auth._get_user_by_id", new_callable=AsyncMock) as mock_user, \
             patch("app.services.email.send_email", side_effect=_slow_send):
            mock_user.return_value = user
            session.execute = AsyncMock(return_value=MagicMock())
            async with client as c:
                ticks, resp = await _ticks_while(c.post("/api/v2/auth/set-password/request", json={"new_password": "NewPass1!"}))
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["delivered"] is True
        assert ticks >= _MIN_TICKS, ticks
    finally:
        app.dependency_overrides.clear()


# ── 구조: 고친 파일의 async 함수 안에 동기 발송 맨 호출 0 ──

_FIXED_FILES = ("app/routers/auth.py", "app/services/onboarding_activation.py", "app/routers/org_invites.py")
_SYNC_SENDERS = {"send_email", "send_invite_email"}


def _bare_sync_sends_in_async(path: Path) -> list[str]:
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
            if self.stack and self.stack[-1] == "async" and name in _SYNC_SENDERS:
                found.append(f"{path.name}:{n.lineno} {name}")
            self.generic_visit(n)

    V().visit(tree)
    return found


def test_no_bare_sync_email_send_inside_async_functions_in_the_fixed_files():
    root = Path(__file__).resolve().parents[1]
    offenders = [hit for rel in _FIXED_FILES for hit in _bare_sync_sends_in_async(root / rel)]
    assert offenders == [], offenders
