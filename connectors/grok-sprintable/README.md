# Sprintable Adapter for Grok (xAI Grok Build)

xAI Grok Build용 Sprintable Gateway dial-out 어댑터 (카테고리 B — Zed ACP stdio 호스트).

**gemini 호스트와 완전 동형** — 동일한 **Zed Agent Client Protocol** 사용.
차이는 spawn 명령뿐: `gemini --acp` → `grok agent stdio`.

## 인터페이스 분기 (B/C 판정)

**→ 카테고리 B (Zed ACP stdio)** 확정. 근거:
- `zed.dev/acp/agent/grok-build` — Grok Build이 **Zed ACP 공식 에이전트**로 등재
- `grok agent stdio` = JSON-RPC 2.0 over stdio (Zed Agent Client Protocol)
- xAI는 API(`api.x.ai`, OpenAI 호환)도 제공하나, 코딩 에이전트는 **ACP stdio** 제공 → B
- ACP는 gemini와 동일 표준 → gemini host.py 골격 그대로 재사용

## 요구사항

- **Grok Build 설치 필수** (`grok agent stdio` 사용). SuperGrok / X Premium Plus 구독.
  ```bash
  curl -fsSL https://x.ai/cli/install.sh | bash
  grok --version
  ```
- Python 3.10+ (asyncio subprocess)
- `httpx` (공통 SDK 의존)

## 설치 및 실행

```bash
# 1. git pull
git pull origin develop

# 2. 환경 변수 설정
export AGENT_API_KEY=sk_live_...            # Sprintable agent API key (필수)
export SPRINTABLE_API_URL=https://...       # Backend URL (미설정 시 dev 기본값)
# export GROK_BIN=/path/to/grok             # grok 바이너리 경로 (기본: PATH의 grok)

# 3. 호스트 실행
python connectors/grok-sprintable/host.py
```

## 동작 원리

```
host.py 시작
  → GrokAcpServer.start(): grok agent stdio spawn + ACP initialize 핸드셰이크
  → SprintableSSEClient.run(inject) (공통 SDK)
  → 이벤트마다 inject(ctx):
    → grok.run_turn(ctx.content):
      → session/new (최초 1회, sessionId 캐시)
      → session/prompt({sessionId, prompt:[{type:"text", text}]})
      → session/update(agent_message_chunk) 텍스트 수집
      → session/prompt 반환(stopReason) = turn 완료
    → ctx.reply(response) → POST /api/v2/conversations/{id}/messages
    → ack: SDK 처리
```

## 프로세스 관리 (카테고리 B 핵심 — gemini/codex 동형)

- `GrokAcpServer`가 자식 프로세스를 spawn/own
- `stop()`: SIGTERM(`terminate`) → 5s timeout → `kill` — 좀비 방지
- `host.py` 종료 시 `finally: grok.stop()` 보장 + reader_task cancel

## 실측 ACP 프로토콜

`@zed-industries/agent-client-protocol@0.4.5` 스키마 (PROTOCOL_VERSION=1 — gemini와 동일):
- `initialize({protocolVersion:1, clientCapabilities})` → response
- `session/new({cwd, mcpServers:[]})` → `{sessionId}`
- `session/prompt({sessionId, prompt:[ContentBlock]})` → `{stopReason}`
- client notification: `session/update {sessionId, update:{sessionUpdate:"agent_message_chunk", content:{type:"text",text}}}`

## 단일 session 주의

현재 모든 conversation을 단일 ACP session에 주입 (gemini/codex와 동일).
멀티 conversation 컨텍스트 분리는 후속(ef2603d8)에서 B 어댑터 일괄 `conversation→session` 매핑으로 보강.
