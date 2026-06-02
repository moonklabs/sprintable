# Sprintable Adapter for OpenClaw

OpenClaw용 Sprintable Gateway dial-out 어댑터 (카테고리 A).
SSE dial-out → inbound turn 주입 → 응답 → ack. 인바운드 도메인·웹훅·터널 불필요.

Tlon 채널 어댑터(`extensions/tlon/`)와 동형 구조.

## 설치

```bash
# 1. git pull
git pull origin develop

# 2. openclaw extensions 폴더에 링크
ln -sf "$(pwd)/connectors/openclaw-sprintable" ~/.openclaw/extensions/sprintable

# 3. 환경 변수 설정
export AGENT_API_KEY=sk_live_...
export SPRINTABLE_API_URL=https://...   # 미설정 시 dev 기본값

# 4. OpenClaw 재시작
openclaw restart
```

또는 `~/.openclaw/openclaw.json`에 직접 설정:

```json
{
  "channels": {
    "sprintable": {
      "enabled": true,
      "apiKey": "sk_live_...",
      "apiUrl": "https://sprintable-backend-dev-57iommnikq-du.a.run.app"
    }
  }
}
```

## 동작 원리

```
GET /api/v2/agent/stream (SSE)
  → runSprintableSSE (SDK)
  → onMessage()
  → runtime.channel.inbound.buildContext(...)
  → runtime.channel.inbound.dispatchReply(...)
  → deliver: POST /api/v2/conversations/{id}/messages
  → ack: POST /api/v2/agent/events/ack
```

공통 SDK(`connectors/sdk/sprintable-sse.ts`) 재사용 — SSE 소비·dedup·ack·backoff 담당.
어댑터는 `gateway.startAccount` + inbound turn 주입부만 구현.
