# Sprintable Adapter for Hermes Agent

Hermes Agent용 Sprintable Gateway dial-out 어댑터.
SSE dial-out → 세션 주입 → ack → 응답 전 체인. 웹훅·터널 불필요.

라이브 검증 완료: 산티아고(Santiago) 환경에서 dial-out→주입→ack→응답 전 체인 실증됨.

## 설치

```bash
# 1. git pull (레포 최신화)
git pull origin develop

# 2. 플러그인 배포 (심링크 권장)
ln -sf "$(pwd)/connectors/hermes-sprintable" ~/.hermes/plugins/sprintable

# 또는 복사
cp -r connectors/hermes-sprintable ~/.hermes/plugins/sprintable

# 3. Hermes에서 활성화
hermes plugins enable sprintable-platform

# 4. 환경 변수 설정
export AGENT_API_KEY=sk_live_...            # Sprintable agent API key (필수)
export SPRINTABLE_API_URL=https://...       # Backend URL (미설정 시 dev 기본값)

# 5. Hermes 재시작
hermes gateway restart
```

## 동작 원리

```
GET /api/v2/agent/stream (SSE, long-lived)
  → _on_event() → handle_message() → 세션 주입
  → send() → POST /api/v2/conversations/{id}/messages
  → _send_ack(seq) → POST /api/v2/agent/events/ack
```

- `Last-Event-ID` 헤더로 reconnect 커서 유지
- contiguous-ack: seq <= _last_acked 중복 skip
- event_id 기반 dedup (300s TTL)
- Exponential backoff 재연결

## 파일

| 파일 | 역할 |
|------|------|
| `plugin.yaml` | Hermes 플러그인 메타데이터 |
| `__init__.py` | 플러그인 entry point |
| `adapter.py` | SprintableAdapter 구현 |
