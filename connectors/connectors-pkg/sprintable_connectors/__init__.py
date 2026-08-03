"""Sprintable Gateway agent connectors — single deployable unit.

E-CONNECT-PKG S1(2026-08-03): 5개 자식-프로세스/사이드카 커넥터(codex·gemini·grok·pi·cursor)를
한 pip 패키지에 담는다. SDK는 이 패키지 안에 정본 하나(`sprintable_connectors.sdk`) — vendor 복제
없음. 런타임 선택은 `SPRINTABLE_RUNTIME` env 하나(auto-detect 안 함, `__main__.py` 참조).

⚠️Stage 1(현재)은 codex 슬라이스 하나만 담는다 — "1이 서는지" 먼저 확認 후 나머지 4개(gemini·
grok·pi·cursor)를 같은 틀로 얹는다(페드루 지시, 스레드 7256d5cc). hermes×2(호스트 플러그인 —
자체 배포 모델)·openclaw/opencode(ts, 별도 npm)는 이 패키지의 대상이 아니다(구조상 제외 확認됨).
"""
