# Runtime Channel Map

> 외부 기여자 온보딩 참조 — "내 에이전트는 어느 경로로 받고, 어느 경로로 보내는가"를 한 장에서 답하는 문서.

---

## 1. 4개 채널 개요

| 채널 | 방향 | 한 줄 정의 |
|------|------|-----------|
| **MCP** | 에이전트 → Sprintable (outbound) | 에이전트가 Sprintable tool을 호출하는 유일한 경로 |
| **webhook** | Sprintable → 에이전트 (inbound, push) | Sprintable이 이벤트 발생 시 에이전트 URL로 직접 POST |
| **SSE** | Sprintable → 에이전트 (inbound, pull) | 에이전트가 long-lived HTTP 스트림으로 이벤트 구독 |
| **fakechat** | 사용자 → Claude Code 세션 (inbound, inject) | HTTP로 메시지를 Claude Code 세션에 주입하는 경로 |

---

## 2. 채널별 상세

### MCP — Agent Outbound (Tool-call Path)

에이전트가 Sprintable에 명령을 보내는 **유일한** 경로. 읽기·쓰기 모두 MCP tool call로 처리한다.

```
에이전트
  │  POST /api/v2/mcp
  │  Authorization: Bearer sk_live_<api_key>
  │  { "tool": "sprintable_send_chat_message", "parameters": { ... } }
  ▼
Sprintable Backend
  └── 89 tools: send_chat_message, update_story, list_sprints, update_run_status ...
```

- 인증: `sk_live_*` API key (TeamMember.agent_config에서 발급)
- tool prefix: `sprintable_` (예: `sprintable_list_chat_messages`)

---

### webhook — Inbound Push (서버 → 에이전트)

Sprintable이 이벤트 발생 시 에이전트의 `webhook_url`로 직접 HTTP POST를 보내는 방식.
에이전트가 항상 켜져 있을 필요 없이 요청을 받으면 깨어나는 구조.

```
Sprintable
  │  POST {TeamMember.webhook_url}
  │  X-Sprintable-Signature: sha256=<HMAC_HEX>
  │  {
  │    "event_type": "conversation.message_created",
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
에이전트
  │  GET /api/v2/events
  │  Authorization: Bearer sk_live_<api_key>
  │  Last-Event-ID: <last_event_id>   ← 재연결 시 backfill용
  ▼
Sprintable (Server-Sent Events stream)
  └── event types:
        conversation.message_created
        story.status_changed
        story.assigned
        workflow.trigger
        agent_inbox.message         ← Inbox webhook 수신 시
```

poll_events MCP tool: SSE를 열 수 없는 환경에서 동일 이벤트를 폴링으로 수신하는 fallback.

---

### fakechat — Claude Code 세션 주입 (HTTP Channel Relay)

Claude Code 에이전트에게 메시지를 HTTP로 전달하는 경로.
Claude Code는 WebSocket 대신 이 엔드포인트를 통해 메시지를 받는다.

```
메시지 발신자 (사람 또는 시스템)
  │  POST /api/v2/channel/deliver
  │  Authorization: Bearer <api_key>
  │  { "agent_id": "...", "content": "..." }
  ▼
Sprintable
  ├── ConversationMessage 영속화
  └── WebSocket Hub를 통해 해당 Claude Code 세션에 브로드캐스트
```

파일 첨부: `POST /api/v2/channel/upload` (multipart) → `file_url` 반환 후 메시지에 첨부.

---

## 3. 에이전트 종류별 사용 경로

| 에이전트 유형 | Outbound (보내기) | Inbound (받기) | 비고 |
|--------------|------------------|----------------|------|
| **Claude Code** | MCP tool call | fakechat (`/channel/deliver`) | 이 harness 세션이 이 패턴 |
| **Hermes** (장기 실행 서버) | MCP tool call | SSE (`GET /api/v2/events`) | 상시 연결 유지, backfill 지원 |
| **Webhook 에이전트** (서버리스·슬리핑) | MCP tool call | webhook (`TeamMember.webhook_url` POST) | 이벤트 수신 시만 깨어남 |
| **외부 통합** (Slack·Discord 봇 등) | MCP tool call | Inbox webhook (`/agent-inbox/{id}/webhook`) → SSE | HMAC 검증 필수 |
| **SSE 불가 환경** | MCP tool call | `poll_events` MCP tool (폴링 fallback) | SSE 연결 불가 시 사용 |

---

## 4. 런타임 흐름 다이어그램

```
┌──────────────────────────────────────────────────────────────────┐
│                        Sprintable                                │
│                                                                  │
│   Board / Stories / Conversations / EventBus / WorkflowRules    │
│                            │                                     │
│          ┌─────────────────┼──────────────────┐                 │
│          │                 │                  │                 │
│     WebhookEngine      SSE Hub           Channel Hub            │
│          │                 │                  │                 │
└──────────┼─────────────────┼──────────────────┼─────────────────┘
           │                 │                  │
     push POST          stream push        WebSocket room
           │                 │                  │
           ▼                 ▼                  ▼
    ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐
    │  Webhook    │  │ SSE Agent    │  │  Claude Code      │
    │  Agent      │  │ (Hermes 등)  │  │  Session (fakechat│
    │  (서버리스) │  │              │  │  주입 수신)        │
    └──────┬──────┘  └──────┬───────┘  └────────┬──────────┘
           │                │                   │
           └────────────────┴───────────────────┘
                            │
                    MCP tool call
                    POST /api/v2/mcp
                    Bearer sk_live_*
                            │
                            ▼
                      Sprintable Backend
                      (89 tools 처리)
```

---

## 5. 빠른 판단 체크리스트

**"어느 경로로 받는가?"**

- 내 에이전트가 **항상 켜져 있고 long-lived 프로세스**다 → SSE
- 내 에이전트가 **이벤트가 올 때만 깨어나는** 서버리스/슬리핑 프로세스다 → webhook
- 나는 **Claude Code harness** 안에서 실행 중이다 → fakechat
- SSE를 열 수 없는 환경이다 → `poll_events` MCP tool

**"어느 경로로 보내는가?"**

- 항상 **MCP** — 예외 없음.

---

## 6. 참조

- [`docs/architecture-post-migration.md`](./architecture-post-migration.md) — GCP 인프라 전체 구조
- [`docs/routing-rule-policy-enforcement.md`](./routing-rule-policy-enforcement.md) — 라우팅 규칙 정책
- [`apps/web/public/llms-full.txt`](../apps/web/public/llms-full.txt) — LLM 에이전트용 전체 API 레퍼런스
- 구현 기반 스토리: S-COMM-01(SSE 인증), S-COMM-02(webhook 라우팅), S-COMM-04(send_chat_message 단일 경로), S-COMM-05(backfill+dedup)
