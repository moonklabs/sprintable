"""story #4336 PR2(PO 04:32Z) — 요청 경로의 스토리지 호출에 **명시 시한**.

GCS 라이브러리(google-cloud-storage 3.12) 기본은 HTTP 호출마다 60초 · 재시도 합계 120초라, 요청 안에서 기다리면 BFF 한도(55초)를
넘을 수 있었다. 호출부가 이 도우미로 호출마다 시한을 걸고, 넘으면 `StorageCallTimeoutError`(라우트가 504 코드 있는 본문으로)로 끊는다.
공급자 서명을 바꾸지 않으려고 바깥에서 `asyncio.wait_for`로 감싼다(공급자 · 테스트 대역 무변경). `asyncio.to_thread` 안의 블로킹 호출은
취소되지 않아 스레드는 라이브러리 시한까지 남을 수 있다 — 요청은 그 전에 답한다(쓰기 결과는 커밋 전이라 행이 남지 않는다).
"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import TypeVar

T = TypeVar("T")


class StorageCallTimeoutError(Exception):
    """스토리지 호출 하나가 정한 시한 안에 끝나지 않음."""

    def __init__(self, what: str, seconds: float) -> None:
        super().__init__(f"storage {what} exceeded {seconds:g}s")
        self.what = what
        self.seconds = seconds


async def with_storage_deadline(awaitable: Awaitable[T], *, seconds: float, what: str) -> T:
    try:
        return await asyncio.wait_for(awaitable, timeout=seconds)
    except asyncio.TimeoutError as exc:
        raise StorageCallTimeoutError(what, seconds) from exc
