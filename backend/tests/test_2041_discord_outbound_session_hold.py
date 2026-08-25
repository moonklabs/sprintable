"""story #2041(그라운딩 doc 67b44d1e, PR-B) — `_dispatch_discord_outbound`가 DB 세션을
연 채 외부 HTTP(discord webhook) 호출을 하지 않는지 회귀가드.

핵심 검증축:
①세션이 닫힌 **뒤**에 첫 httpx POST가 일어난다(연결 보유 시간 단축이 이 PR의 목적).
②원본과 동일 픽 규칙(member_id별 channel="discord"·is_active·`.first()`)으로 웹훅 URL을
  뽑아 discord 멤버 전원에게 정확히 전달한다(동작 무변화 — 회귀 0).
③웹훅 미설정 멤버는 스킵(AC11, 기존 로그 경로 유지).
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


class _FakeSession:
    """async_session_factory()의 `async with` 대상 — __aexit__ 호출 시점을 외부에서
    관측할 수 있게 call_order 리스트에 직접 기록한다.

    ⚠️`async with`는 dunder(`__aenter__`/`__aexit__`)를 **타입**에서 찾는다(인스턴스
    속성 재대입으로는 가로챌 수 없음) — 그래서 인스턴스별 mock 대신 이 클래스 자체가
    call_order를 받아 기록하게 짰다."""

    def __init__(self, state: dict, execute_side_effect, call_order: list[str] | None = None):
        call_order = call_order if call_order is not None else []
        self._state = state
        self._execute_side_effect = execute_side_effect
        self._call_order = call_order

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        self._state["session_closed"] = True
        self._call_order.append("session_closed")
        return False

    async def execute(self, *args, **kwargs):
        return self._execute_side_effect(*args, **kwargs)


def _make_scalars_result(row):
    result = MagicMock()
    result.scalars.return_value.first.return_value = row
    return result


async def test_httpx_post_happens_after_session_closed_and_all_members_dispatched():
    from app.routers.conversations import _dispatch_discord_outbound
    from app.services.channel_router import DeliveryDecision

    org_id = uuid.uuid4()
    message_id = uuid.uuid4()
    member_with_hook = uuid.uuid4()
    member_without_hook = uuid.uuid4()

    decisions = [
        DeliveryDecision(member_id=member_with_hook, channel="discord", level="full", reason="test"),
        DeliveryDecision(member_id=member_without_hook, channel="discord", level="full", reason="test"),
    ]

    wh_row = MagicMock()
    wh_row.url = "https://discord.com/api/webhooks/123/abc"

    def _execute_side_effect(*args, **kwargs):
        # 첫 호출은 member_with_hook, 두 번째는 member_without_hook — 원본과 동일하게
        # 호출 순서대로 decisions를 훑으므로, 호출 카운터로 어느 멤버 차례인지 흉내낸다.
        _execute_side_effect.calls += 1
        if _execute_side_effect.calls == 1:
            return _make_scalars_result(wh_row)
        return _make_scalars_result(None)
    _execute_side_effect.calls = 0

    state: dict = {"session_closed": False}
    call_order: list[str] = []
    fake_session = _FakeSession(state, _execute_side_effect, call_order)

    posted_urls: list[str] = []

    class _FakeAsyncClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json=None):
            call_order.append(f"post:{url}")
            posted_urls.append(url)
            return MagicMock(status_code=204)

    with patch("app.core.database.async_session_factory", return_value=fake_session), \
         patch("app.services.channel_router.route_message", new=AsyncMock(return_value=decisions)), \
         patch("httpx.AsyncClient", new=_FakeAsyncClient):
        await _dispatch_discord_outbound(message_id, org_id)

    assert state["session_closed"] is True
    assert posted_urls == ["https://discord.com/api/webhooks/123/abc"], (
        "웹훅이 설정된 멤버 1명에게만, 정확한 URL로 1회 POST돼야 한다(회귀 0)"
    )
    assert call_order.index("session_closed") < call_order.index(f"post:{posted_urls[0]}"), (
        f"순서 위반 — httpx POST가 DB 세션 종료보다 먼저(또는 동시에) 일어남: {call_order}. "
        "세션을 닫기 전에 외부 I/O를 하면 그 시간만큼 커넥션을 붙든다(story #2041 재발)."
    )


async def test_no_discord_members_skips_dispatch_without_opening_httpx():
    from app.routers.conversations import _dispatch_discord_outbound
    from app.services.channel_router import DeliveryDecision

    org_id = uuid.uuid4()
    message_id = uuid.uuid4()
    decisions = [
        DeliveryDecision(member_id=uuid.uuid4(), channel="sse", level="full", reason="test"),
    ]

    state: dict = {"session_closed": False}
    fake_session = _FakeSession(state, lambda *a, **kw: _make_scalars_result(None))

    httpx_client_created = {"n": 0}

    class _FakeAsyncClient:
        def __init__(self, *a, **kw):
            httpx_client_created["n"] += 1

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def post(self, url, json=None):
            return MagicMock(status_code=204)

    with patch("app.core.database.async_session_factory", return_value=fake_session), \
         patch("app.services.channel_router.route_message", new=AsyncMock(return_value=decisions)), \
         patch("httpx.AsyncClient", new=_FakeAsyncClient):
        await _dispatch_discord_outbound(message_id, org_id)

    assert httpx_client_created["n"] == 0, "discord 채널 결정이 없으면 httpx조차 열지 않아야 한다"
