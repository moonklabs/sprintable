"""story #4272(까디르 codex 01a0d43b P1) — 발행 명령 한 건이 공급자 쓰기 호출에 들어갔는가.

미분류 예외(코드 없음)가 났을 때 «나갔는지 모름»(needs_check · 사람 확인)과 «아직 안 나감»(transient · 자동 재시도, 이중 발행 0)을
가르는 표시다. 워커 배치가 명령마다 `reset_provider_call_mark()`로 지우고, 발행 경로는 공급자에 쓰는 첫 호출 **직전**에
`mark_provider_call()`을 부른다(읽기 호출 — 게시 한도 조회 등 — 은 표시하지 않는다). 발행 시도 장부의 `adapter_called`도 코드가
없을 땐 이 표시를 그대로 적는다. 코드가 있는 실패는 코드 표(`publication_command.py` `_NOT_SENT_CODES` 등)가 가른다.

같은 태스크 안의 await 사슬은 컨텍스트를 공유하므로 호출된 함수 안에서 세운 표시가 워커까지 보인다(새 태스크를 띄우는
경로라면 띄우기 전에 표시한다).
"""
from __future__ import annotations

from contextvars import ContextVar

_PROVIDER_CALL_MARK: ContextVar[bool] = ContextVar("publication_provider_call_mark", default=False)


def reset_provider_call_mark() -> None:
    _PROVIDER_CALL_MARK.set(False)


def mark_provider_call() -> None:
    _PROVIDER_CALL_MARK.set(True)


def provider_call_marked() -> bool:
    return _PROVIDER_CALL_MARK.get()
