# Sprintable Adapter for Gemini

Gemini용 Sprintable Gateway dial-out 어댑터 (카테고리 B — ACP stdio JSON-RPC 호스트).

**codex 호스트와 동형 골격** (자식 프로세스 spawn/own + lifetime 관리).
차이 = RPC 레이어: gemini는 **`gemini --acp`** (Agent Client Protocol, 표준 JSON-RPC/stdio).
codex app-server 자체 RPC와 달리 ACP는 표준이라 향후 ACP 런타임에 재사용 가능.

## 요구사항

- **gemini-cli 설치 필수** (`gemini --acp` 사용).
  ```bash
  npm install -g @google/gemini-cli   # 또는 공식 설치 경로
  gemini --version
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
# export GEMINI_BIN=/path/to/gemini         # gemini 바이너리 경로 (기본: PATH의 gemini)

# 3. 호스트 실행
python connectors/gemini-sprintable/host.py
```

## 동작 원리

```
host.py 시작
  → GeminiAcpServer.start(): gemini --acp spawn + ACP initialize 핸드셰이크
  → SprintableSSEClient.run(inject) (공통 SDK)
  → 이벤트마다 inject(ctx):
    → gemini.run_turn(ctx.content):
      → session/new (최초 1회, sessionId 캐시)
      → session/prompt({sessionId, prompt:[{type:"text", text}]})
      → session/update(agent_message_chunk) 텍스트 수집
      → session/prompt 반환(stopReason) = turn 완료
    → ctx.reply(response) → POST /api/v2/conversations/{id}/messages
    → ack: SDK 처리
```

## 프로세스 관리 (카테고리 B 핵심 — codex 동형)

- `GeminiAcpServer`가 자식 프로세스를 spawn/own
- `stop()`: SIGTERM(`terminate`) → 5s timeout → `kill` — 좀비 방지
- `host.py` 종료 시 `finally: gemini.stop()` 보장 + reader_task cancel

## 실측 ACP 프로토콜

`@zed-industries/agent-client-protocol@0.4.5` 스키마 (PROTOCOL_VERSION=1):
- `initialize({protocolVersion:1, clientCapabilities})` → response
- `session/new({cwd, mcpServers:[]})` → `{sessionId}`
- `session/prompt({sessionId, prompt:[ContentBlock]})` → `{stopReason}`
- client notification: `session/update {sessionId, update:{sessionUpdate:"agent_message_chunk", content:{type:"text",text}}}`

ContentBlock text variant: `{type:"text", text}` (모든 ACP agent 필수 지원).

## 단일 session 주의

현재 모든 conversation을 단일 ACP session에 주입 (codex 단일 thread와 동일).
멀티 conversation 컨텍스트 분리는 후속(ef2603d8)에서 B 어댑터 일괄 `conversation→session` 매핑으로 보강.
