# Sprintable Adapter for Codex

Codex용 Sprintable Gateway dial-out 어댑터 (카테고리 B — stdio JSON-RPC 호스트).

A 카테고리(in-process)와 달리, **자식 프로세스(`codex app-server`)를 spawn/own**하고
stdio JSON-RPC로 turn을 주입한다. gemini/pi/grok 어댑터가 이 패턴을 따른다.

## 요구사항

- **codex CLI 설치 필수** (`codex app-server` 사용). codex-cli ≥ 0.124.0 권장.
  ```bash
  brew install codex   # 또는 공식 설치 경로
  codex --version
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
# export CODEX_BIN=/path/to/codex           # codex 바이너리 경로 (기본: PATH의 codex)

# 3. 호스트 실행
python connectors/codex-sprintable/host.py
```

## 동작 원리

```
host.py 시작
  → CodexAppServer.start(): codex app-server spawn + initialize/initialized 핸드셰이크
  → SprintableSSEClient.run(inject) (공통 SDK)
  → 이벤트마다 inject(ctx):
    → codex.run_turn(ctx.content):
      → thread/start (최초 1회, thread_id 캐시)
      → turn/start({threadId, input:[{type:"text", text}]})
      → item/completed(agentMessage) 텍스트 수집
      → turn/completed 에서 응답 확정
    → ctx.reply(response) → POST /api/v2/conversations/{id}/messages
    → ack: SDK 처리
```

## 프로세스 관리 (카테고리 B 핵심)

- `CodexAppServer`가 자식 프로세스를 spawn/own
- `stop()`: SIGTERM(`terminate`) → 5s timeout → `kill` — 좀비 방지
- `host.py` 종료(KeyboardInterrupt/SSE 종료) 시 `finally: codex.stop()` 보장
- reader_task는 stop 시 cancel

## 실측 프로토콜

`codex app-server generate-ts`로 추출한 실측 JSON-RPC (codex-cli 0.124.0):
- `initialize` → `initialized` (notification)
- `thread/start` → `{thread: {id}}`
- `turn/start({threadId, input: [UserInput]})` — `UserInput = {type:"text", text, text_elements}`
- `ServerNotification`: `item/completed {item:{type:"agentMessage", text}}`, `turn/completed`

stdio 안정 경로 사용 (실험적 WS 미사용).
