# Sprintable Adapter for OpenCode

OpenCode용 Sprintable Gateway dial-out 어댑터 (카테고리 A).
SSE dial-out → session.prompt 주입 → 응답 → ack. 인바운드 도메인·웹훅·터널 불필요.

## 설치

```bash
# 1. git pull
git pull origin develop

# 2. opencode plugin 설정 (~/.config/opencode/package.json)
{
  "dependencies": {
    "@sprintable/opencode-adapter": "file:./connectors/opencode-sprintable"
  }
}

# 또는 심링크
ln -sf "$(pwd)/connectors/opencode-sprintable" ~/.config/opencode/plugins/sprintable

# 3. 환경 변수 설정
export AGENT_API_KEY=sk_live_...            # Sprintable agent API key (필수)
export SPRINTABLE_API_URL=https://...       # Backend URL (미설정 시 dev 기본값)
export SPRINTABLE_ALLOWED_USERS=...        # 허용 member_id (comma-sep)

# 4. OpenCode 재시작
opencode
```

## 동작 원리

```
Plugin 초기화
  → background runSprintableSSE (SDK, AbortController)
  → 이벤트마다:
    → client.session.create() 또는 기존 session 재사용
    → client.session.prompt({path:{id}, body:{parts:[{type:"text",text}]}})
    → 응답 → POST /api/v2/conversations/{id}/messages
    → POST /agent/events/ack (SDK 처리)
```

- Conversation → OpenCode session 매핑 캐시 (재사용)
- AbortController로 graceful shutdown
- SSE·dedup·ack·backoff는 공통 SDK(`connectors/sdk/sprintable-sse.ts`) 담당
