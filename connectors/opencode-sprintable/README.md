# opencode-sprintable

Sprintable Gateway channel plugin for [OpenCode](https://opencode.ai) — two-way chat between an OpenCode session and its Sprintable team. SSE dial-out (no inbound domain/webhook/tunnel required).

## Install

```bash
opencode plugin opencode-sprintable
```

One command — OpenCode fetches the npm package (Bun-installed automatically on next startup) and updates your `opencode.json`/`opencode.jsonc` plugin config. No manual `package.json` editing or symlinking needed.

Then set your Sprintable agent credentials before starting `opencode`:

```bash
export AGENT_API_KEY=sk_live_...            # Sprintable agent API key (required)
export SPRINTABLE_API_URL=https://...       # Backend URL (defaults to https://app.sprintable.ai)
```

Without a key set, the plugin loads and does nothing (no error, no SSE connection) — safe to install ahead of configuring credentials.

## 동작 원리

```
Plugin 초기화
  → background runSprintableSSE (vendored SDK, AbortController)
  → 이벤트마다:
    → client.session.create() 또는 기존 session 재사용
    → client.session.prompt({path:{id}, body:{parts:[{type:"text",text}]}})
    → 응답 → POST /api/v2/conversations/{id}/messages
    → POST /agent/events/ack (SDK 처리)
  → dispose(): AbortController.abort()로 SSE 루프 정지(플러그인 unload/reload 시)
```

- Conversation → OpenCode session 매핑 캐시 (재사용)
- `dispose` hook으로 SSE 스트림 정리 — `@opencode-ai/plugin`의 실제 `Hooks.dispose`에 배선(설치 시 실 타입 확認, 초안의 "shutdown hook 없음" 가정은 틀렸음).
- SSE·dedup·ack·backoff는 이 패키지에 vendored된 `sprintable-sse.ts`(SDK 원본은 `connectors/sdk/sprintable-sse.ts` — publish된 패키지엔 monorepo 상대경로가 안 살아서 복사본을 담음, drift 방지 위해 SDK 갱신 시 함께 동기화 필요)가 담당.
- **수명 = OpenCode 프로세스 정직 서술**: SSE 연결은 plugin이 로드된 OpenCode 프로세스가 살아있는 동안만 유지된다. OpenCode를 닫으면(또는 플러그인이 disable/reload되면) 연결도 끊긴다 — 별도 데몬/백그라운드 상주 없음. 그 사이 도착한 메시지는 다음 세션 시작 시 backfill로 회수된다(백엔드 seq-cursor 기반, 유실 아님 — 다만 실시간성은 프로세스가 떠 있는 동안만 보장).
- **동시 스트림 한도(키당, tier-aware — free 기본 3)**: 같은 `AGENT_API_KEY`로 동시에 열 수 있는 SSE 연결 수에 상한이 있다(남용/자원독점 방지, fair-use). `kill -9` 등 비정상 종료로 연결이 정상 해제(`dispose`) 안 되면 그 슬롯은 최대 90초(`SSE_HEARTBEAT_TIMEOUT`×3, heartbeat 2회 누락 허용) 후 서버가 자동 회수한다 — **영구 lockout이 아니라 bounded self-heal**. 한도 초과 시 429 응답의 `Retry-After`가 그 스코프에서 가장 먼저 회수될 슬롯까지 남은 실제 초를 알려주므로(story #2582), 그 값만큼 기다렸다 재시도하면 된다.
