# Runtime Channel Map

> 외부 기여자 온보딩 참조 — "내 에이전트는 어느 경로로 받고, 어느 경로로 보내는가"를 한 장에서 답하는 문서.

---

## 1. 4개 채널 개요

| 채널 | 방향 | 한 줄 정의 |
|------|------|-----------|
| **MCP** | 에이전트 → Sprintable (outbound) | 에이전트가 Sprintable tool을 호출하는 유일한 경로 — stdio transport |
| **webhook** | Sprintable → 에이전트 (inbound, push) | Sprintable이 이벤트 발생 시 에이전트 URL로 직접 POST |
| **SSE** | Sprintable → 에이전트 (inbound, pull) | 에이전트가 long-lived HTTP 스트림으로 이벤트 구독 |
| **fakechat** | Sprintable WS → Claude Code 세션 (inbound, inject) | Bun shim이 WS 수신 메시지를 MCP notification으로 Claude Code stdio에 주입 |

---

## 2. 채널별 상세

### MCP — Agent Outbound (stdio Transport)

에이전트가 Sprintable에 명령을 보내는 **유일한** 경로. HTTP REST가 아니라 **MCP stdio transport** 기반.
Claude Code는 `.mcp.json`에 등록된 커맨드(`python -m backend.sprintable_mcp`)를 실행해 stdin/stdout으로 MCP 프로토콜을 주고받는다.

```
# .mcp.json 등록 예
{
  "mcpServers": {
    "sprintable-python": {
      "command": "python",
      "args": ["-m", "backend.sprintable_mcp"],
      "env": {
        "SPRINTABLE_API_URL": "https://api.sprintable.ai",
        "AGENT_API_KEY": "sk_live_..."
      }
    }
  }
}
```

- 내부: `mcp.run_stdio_async()` 실행. SSE 브릿지(`start_sse_bridge`)도 동일 이벤트 루프에서 함께 기동.
- 인증: `AGENT_API_KEY=sk_live_*` 환경 변수 → 서버 시작 시 `/api/v2/auth/me` 검증
- tool prefix: `sprintable_` (예: `sprintable_list_chat_messages`, `sprintable_send_chat_message`)

---

### webhook — Inbound Push (서버 → 에이전트)

Sprintable이 이벤트 발생 시 `webhook_configs.url`로 직접 HTTP POST를 보내는 방식.
(migration `0023` 이후 `TeamMember.webhook_url`은 stale — 실제 발송 모델은 `webhook_configs` 테이블 기준)
에이전트가 항상 켜져 있을 필요 없이 요청을 받으면 깨어나는 구조.

```
Sprintable (conversation_webhook.py)
  │  POST {webhook_configs.url}
  │  X-Hub-Signature-256: sha256=<HMAC_HEX>
  │  {
  │    "event_type": "conversation.message_created",   ← webhook 전용 이름(점 표기)
  │    "conversation_id": "...",
  │    "message_id": "...",
  │    "sender_id": "...",
  │    "content": "preview only"   ← 전문은 list_chat_messages로 조회
  │  }
  ▼
에이전트 webhook endpoint
  └── HTTP 200 즉시 응답 → 비동기 처리 (모범 사례)
```

재시도 정책: 실패 시 1s → 2s → 포기 (총 3회 시도, 타임아웃 10s).

Inbox Webhook (외부 서비스 → 에이전트) 은 별도 경로:
```
외부 서비스
  │  POST /api/v2/agent-inbox/{agent_id}/webhook
  │  X-Sprintable-Signature: sha256=<HMAC_HEX>
  ▼
Sprintable → Event 생성 → SSE로 에이전트에 push
```

---

### SSE — Inbound Pull (에이전트 구독)

에이전트가 long-lived HTTP 연결을 열어 Sprintable에서 실시간 이벤트를 수신하는 방식.
폴링 없이 서버가 밀어주는 구조; 연결 끊기면 `Last-Event-ID`로 재연결 후 backfill.

```
에이전트 (sse_bridge.py — httpx.AsyncClient)
  │  GET /api/v2/events/stream
  │  Authorization: Bearer sk_live_<api_key>
  │  Last-Event-ID: <last_event_id>   ← 재연결 시 backfill용
  ▼
Sprintable (Server-Sent Events stream)
  └── 현재 SSE relay 대상 (`_RELAY_EVENT_TYPES`, sse_bridge.py:31):
        conversation:message          ← 메시지 수신 (콜론 표기)
        conversation:mention

      ※ story.status_changed · story.assignee_changed · manual_trigger 등
         event_taxonomy.py에 정의된 이벤트는 현재 SSE 미중계.
         poll_events MCP tool 또는 webhook으로 수신.
```

> **이벤트명 표기 불일치**: SSE는 콜론 표기(`conversation:message`), webhook은 점 표기(`conversation.message_created`)로 현재 통일되지 않음. 통일 작업은 S-COMM-12(backlog) 예정.

poll_events MCP tool: SSE를 열 수 없는 환경에서 동일 이벤트를 폴링으로 수신하는 fallback.

---

### fakechat — Claude Code 세션 주입 (WS → MCP stdio shim)

`packages/fakechat/server.ts` — Bun 로컬 프로세스. Claude Code와 Sprintable 사이를 중계하는 MCP stdio shim.

**동작 원리:**
1. Bun 프로세스 기동 시 `StdioServerTransport`로 Claude Code stdio에 MCP 서버로 연결
2. 동시에 Sprintable 백엔드 WS에 **클라이언트**로 접속 (`ws://{host}/ws/chat/{agent_id}?api_key=...`)
3. WS 메시지 수신 → `mcp.notification({ method: 'notifications/claude/channel' })` → Claude Code 세션에 `<channel ...>` 태그로 주입

```
Sprintable 백엔드 WS Hub
  │  ws://{SPRINTABLE_WS_BASE}/ws/chat/{agent_id}
  │  (WS push — 대화 메시지)
  ▼
fakechat server (Bun, WS client)
  │  mcp.notification({ method: 'notifications/claude/channel',
  │    params: { content, meta: { chat_id, message_id, thread_id, ... } } })
  ▼
Claude Code 세션 (MCP stdio)
  └── <channel source="fakechat" chat_id="web" message_id="..."> 태그로 전달

역방향 (Claude Code → Sprintable):
  Claude Code (reply tool)
    │  fetch(replyCallbackUrl, { method: 'POST' })
    │  ← fakechat이 WS payload의 conversation_id로 URL 직접 구성 (server.ts:183)
    │    `${SPRINTABLE_API_URL}/api/v2/conversations/${msg.conversation_id}/messages`
    ▼
  Sprintable Backend
```

---

## 3. 에이전트 종류별 사용 경로

| 에이전트 유형 | Outbound (보내기) | Inbound (받기) | 비고 |
|--------------|------------------|----------------|------|
| **Claude Code** | MCP (stdio) | fakechat — WS→MCP notification 주입 | 이 harness 세션이 이 패턴 |
| **Hermes** (장기 실행 서버) | MCP (stdio) | SSE (`GET /api/v2/events/stream`) | 상시 연결 유지, backfill 지원 |
| **Webhook 에이전트** (서버리스·슬리핑) | MCP (stdio) | webhook (`webhook_configs.url` POST) | 이벤트 수신 시만 깨어남 |
| **외부 통합** (Slack·Discord 봇 등) | MCP (stdio) | Inbox webhook (`/agent-inbox/{id}/webhook`) → EventBus → SSE relay | HMAC 검증 필수 |
| **SSE 불가 환경** | MCP (stdio) | `poll_events` MCP tool (폴링 fallback) | SSE 연결 불가 시 사용 |

---

## 4. 런타임 흐름 다이어그램

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Sprintable Backend                        │
│                                                                     │
│   Board / Stories / Conversations / EventBus / WorkflowRules       │
│                              │                                      │
│         ┌────────────────────┼──────────────────┐                  │
│         │                   │                   │                  │
│   WebhookEngine      SSE /events/stream    WS Hub /ws/chat/*       │
│  (점 이벤트명)        (콜론, 2종 relay)                            │
│         │                   │                   │                  │
└─────────┼───────────────────┼───────────────────┼──────────────────┘
          │                   │                   │
    push POST           SSE stream           WS push
    (event_type:        (event_type:          (JSON msg)
conversation.           conversation
message_created)        :message)
          │                   │                   │
          ▼                   ▼                   ▼
   ┌────────────┐     ┌──────────────┐     ┌─────────────────────────┐
   │  Webhook   │     │  SSE Agent   │     │  fakechat (Bun, stdio)  │
   │  Agent     │     │  (Hermes 등) │     │  WS client              │
   │  (서버리스)│     │  + MCP stdio │     │  → mcp.notification     │
   └─────┬──────┘     └──────┬───────┘     │  → Claude Code stdio    │
         │                   │             └──────────┬──────────────┘
         │                   │                        │
         └───────────────────┴────────────────────────┘
                             │
              MCP stdio (python -m backend.sprintable_mcp)
              인증: AGENT_API_KEY=sk_live_*
                             │
                             ▼
                       Sprintable Backend
                       (API 호출, 91 tools)
```

---

## 5. 빠른 판단 체크리스트

**"어느 경로로 받는가?"**

- 내 에이전트가 **항상 켜져 있고 long-lived 프로세스**다 → SSE (`GET /api/v2/events/stream`)
- 내 에이전트가 **이벤트가 올 때만 깨어나는** 서버리스/슬리핑 프로세스다 → webhook
- 나는 **Claude Code harness** 안에서 실행 중이다 → fakechat (Bun shim 필요)
- SSE를 열 수 없는 환경이다 → `poll_events` MCP tool

**"어느 경로로 보내는가?"**

- 항상 **MCP** (stdio transport) — 예외 없음.

---

## 6. 참조

- [`docs/architecture-post-migration.md`](./architecture-post-migration.md) — GCP 인프라 전체 구조
- [`docs/routing-rule-policy-enforcement.md`](./routing-rule-policy-enforcement.md) — 라우팅 규칙 정책
- [`apps/web/public/llms-full.txt`](../apps/web/public/llms-full.txt) — LLM 에이전트용 전체 API 레퍼런스
- [`packages/fakechat/server.ts`](../packages/fakechat/server.ts) — fakechat 구현체
- [`backend/sprintable_mcp/__main__.py`](../backend/sprintable_mcp/__main__.py) — MCP 서버 진입점
- 구현 기반 스토리: S-COMM-01(SSE 인증), S-COMM-02(webhook 라우팅), S-COMM-04(send_chat_message 단일 경로), S-COMM-05(backfill+dedup), S-COMM-12(SSE/webhook 이벤트명 통일, backlog)
