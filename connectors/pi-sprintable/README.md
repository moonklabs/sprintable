# Sprintable Adapter for Pi

Pi용 Sprintable Gateway dial-out 어댑터 (카테고리 B — JSONL/stdio 호스트).

**codex/gemini 호스트와 동형 골격** (자식 프로세스 spawn/own + lifetime 관리).
차이 = 메시지 레이어: pi는 **`pi --mode rpc`** (JSONL/stdio — JSON-RPC 아닌 **줄단위 JSON**).
`steer`로 mid-stream 주입이 pi 강점.

## 요구사항

- **pi 설치 필수** (`pi --mode rpc` 사용).
  ```bash
  npm install -g @earendil-works/pi-coding-agent   # bin: pi
  pi --version
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
# export PI_BIN=/path/to/pi                  # pi 바이너리 경로 (기본: PATH의 pi)

# 3. 호스트 실행
python connectors/pi-sprintable/host.py
```

## 동작 원리

```
host.py 시작
  → PiRpcServer.start(): pi --mode rpc spawn (JSONL은 별도 initialize 핸드셰이크 없음)
  → SprintableSSEClient.run(inject) (공통 SDK)
  → 이벤트마다 inject(ctx):
    → pi.run_turn(ctx.content):
      → stdin JSONL: {"type":"prompt", "message": text}
      → stdout JSONL: AgentSessionEvent 스트림 (session.subscribe)
      → agent_end {messages:[AgentMessage]} 에서 assistant 텍스트 수집
    → ctx.reply(response) → POST /api/v2/conversations/{id}/messages
    → ack: SDK 처리
```

## 메시지 레이어 (JSONL — JSON-RPC와 차이)

codex/gemini는 JSON-RPC(id/method/params/result)지만, pi는 **줄단위 JSON 명령/이벤트**:
- 명령(stdin): `{"type":"prompt", "message", "streamingBehavior"?:"steer"|"followUp"}`
- mid-stream 주입(stdin): `{"type":"steer", "message"}` — pi 강점
- 응답(stdout): `{"type":"response", "command":"prompt", "success":true}` = ack
- 이벤트(stdout): `AgentSessionEvent` — `agent_end {messages}`, `turn_end {message}`, `message_update {...}` 등

## 프로세스 관리 (카테고리 B 핵심 — codex/gemini 동형)

- `PiRpcServer`가 자식 프로세스를 spawn/own
- `stop()`: SIGTERM(`terminate`) → 5s timeout → `kill` — 좀비 방지
- `host.py` 종료 시 `finally: pi.stop()` 보장 + reader_task cancel

## 실측 스키마

`@earendil-works/pi-coding-agent@0.78.0` `dist/modes/rpc/rpc-types.d.ts`:
- `RpcCommand: {type:"prompt"|"steer"|"follow_up", message, streamingBehavior?}`
- `RpcResponse: {type:"response", command, success}`

`@earendil-works/pi-agent-core@0.78.0` `dist/types.d.ts`:
- `AgentEvent: agent_end {messages:[AgentMessage]}`, `turn_end {message}`, ...

`@earendil-works/pi-ai@0.78.0`:
- `AssistantMessage.content: (TextContent{type:"text",text} | ...)[]`

## 단일 세션 주의

현재 모든 conversation을 단일 pi 세션에 주입 (codex/gemini와 동일).
멀티 conversation 컨텍스트 분리는 후속(ef2603d8)에서 B 어댑터 일괄 보강.
