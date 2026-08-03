"""Sprintable Gateway agent connectors — single deployable unit.

E-CONNECT-PKG S1(2026-08-03): 5개 자식-프로세스/사이드카 커넥터(codex·gemini·grok·pi·cursor)를
한 pip 패키지에 담는다. SDK는 이 패키지 안에 정본 하나(`sprintable_connectors.sdk`) — vendor 복제
없음. 런타임 선택은 `SPRINTABLE_RUNTIME` env 하나(auto-detect 안 함, `__main__.py` 참조).

Stage 1(2026-08-03) 완료 — 5종 전부 등록: codex·cursor(1차)·gemini·grok·pi(2차, cursor 먼저
검증 후 나머지). 각 모듈은 원본(connectors/*-sprintable/*.py)의 프로토콜 로직과 byte-identical
(diff 확認 완료) — 유일한 변경은 sys.path 상대깊이 해킹 → 패키지 상대 import(`.sdk`).
hermes×2(호스트 플러그인 — 자체 배포 모델)·openclaw/opencode(ts, 별도 npm)는 이 패키지의
대상이 아니다(구조상 제외 확認됨, 페드루 지시, 스레드 7256d5cc).

실측(레포 밖 완전히 빈 디렉터리, 새 venv, wheel만 설치):
  codex·cursor — 실 AGENT_API_KEY로 SSE dial-out "stream open" 확認(HTTP 200)
  gemini·grok·pi — 패키지 import·SPRINTABLE_RUNTIME 라우팅까지 정상, 이후 각자 CLI 바이너리
    (gemini/grok/pi) 부재로 FileNotFoundError — 이 환경에 해당 CLI가 없어 발생하는 예상된
    실패이며 원본 커넥터도 동일 전제(README "◯◯-cli 설치 필수"). 패키징/import 결함 아님을
    정확한 실패 지점(subprocess spawn, ImportError 아님)으로 확認.
"""
