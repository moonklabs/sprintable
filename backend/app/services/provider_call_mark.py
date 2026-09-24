"""story #4272(까디르 codex 01a0d43b P1) — 발행 명령 한 건이 공급자 쓰기 호출에 들어갔는가.

미분류 예외(코드 없음)가 났을 때 «나갔는지 모름»(needs_check · 사람 확인)과 «아직 안 나감»(transient · 자동 재시도, 이중 발행 0)을
가르는 표시다. 워커 배치가 명령마다 `reset_provider_call_mark()`로 지운다. 발행 시도 장부의 `adapter_called`도 코드가 없을 땐 이
표시를 그대로 적는다. 코드가 있는 실패는 코드 표(`publication_command.py`)가 가른다.

**표시는 공급자 쓰기 요청이 실제로 나가는 한 자리에서만 켜진다**(까디르 codex 두 번째 · PO 17:54Z): 발행 경로의 HTTP 클라이언트는
전부 `provider_client()`로 만들고, 그 클라이언트의 요청 훅이 쓰기 메서드(POST · PUT · PATCH · DELETE) 요청을 보내기 직전에 표시한다.
읽기(GET — 게시 한도 · 원본 미디어 가져오기 · 상태 조회)는 표시하지 않는다. 예전엔 호출처마다 손으로 표시를 달아 빠지는 자리가
생겼고(비동기 이미지 컨테이너를 다음 tick에 게시하는 `publish_container`) 너무 이른 자리도 있었다(원본 GET · URL 검증 전).
구조 가드(`test_4272…`)가 발행 경로 모듈의 맨 `httpx.AsyncClient`를 막는다.

같은 태스크 안의 await 사슬은 컨텍스트를 공유하므로 요청 훅이 세운 표시가 워커까지 보인다. sandbox 어댑터는 HTTP를 안 보내
표시가 켜지지 않는다(실 공급자 쓰기가 없으니 이중 게시도 없다 — 알려진 한계).
"""
from __future__ import annotations

from contextvars import ContextVar
from typing import Any

import httpx

_PROVIDER_CALL_MARK: ContextVar[bool] = ContextVar("publication_provider_call_mark", default=False)


def reset_provider_call_mark() -> None:
    _PROVIDER_CALL_MARK.set(False)


def mark_provider_call() -> None:
    _PROVIDER_CALL_MARK.set(True)


def provider_call_marked() -> bool:
    return _PROVIDER_CALL_MARK.get()


_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


async def _mark_on_write_request(request: httpx.Request) -> None:
    if request.method.upper() in _WRITE_METHODS:
        mark_provider_call()


def provider_client(**kwargs: Any) -> httpx.AsyncClient:
    """발행 경로 전용 HTTP 클라이언트 — 쓰기 요청이 나가기 직전 표시를 켠다(모듈 설명). 인자는 `httpx.AsyncClient` 그대로."""
    hooks = dict(kwargs.pop("event_hooks", None) or {})
    hooks["request"] = [*hooks.get("request", []), _mark_on_write_request]
    return httpx.AsyncClient(event_hooks=hooks, **kwargs)
