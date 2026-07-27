"""story c4c72eb1(E-ARCH, GCE realtime-gateway 이전) PR-A: 프로세스 전역 셧다운 신호.

SSE 생성기(events.py/agent_gateway.py)가 이 이벤트를 구독해 SIGTERM 시 강제
`CancelledError`를 기다리지 않고 스스로 정상 종료(clean stream end)한다 —
`EventSource` 표준 클라이언트가 즉시 재연결하도록 유도(GCLB 드레이닝과 결합
시 건강한 인스턴스로 자동 이동). main.py의 lifespan `finally` 진입 즉시 set한다.

⚠️`asyncio.Event`는 생성자 자체는 loop-agnostic(3.10+)이지만 `.wait()`/`.set()`이
내부 Future를 처음 만들 때 **그 시점의 실행 중 루프에 바인딩**된다 — 이 코드베이스는
TestClient(app)로 lifespan을 여러 번(서로 다른 이벤트루프로) 태우는 테스트 관례가
있어(story bea25062 주석 참조), 모듈 전역 단일 인스턴스를 `.clear()`만 하면 이전
루프에 바인딩된 채로 새 루프에서 `RuntimeError: bound to a different event loop`가
난다(뮤테이션 셀프체크로 직접 재현). 그래서 startup마다 **객체 자체를 재생성**한다 —
호출부는 반드시 `from app.core import shutdown`(모듈 자체)으로 임포트해
`shutdown.shutdown_event`를 매번 속성 접근으로 읽어야 한다(`from ... import
shutdown_event`로 이름을 정적 바인딩하면 재생성 이후에도 옛 객체를 계속 참조한다).
"""
from __future__ import annotations

import asyncio

shutdown_event: asyncio.Event = asyncio.Event()


def reset_shutdown_event() -> None:
    """lifespan startup마다 호출 — 현재 실행 중인 루프에 바인딩된 새 Event로 교체."""
    global shutdown_event
    shutdown_event = asyncio.Event()
