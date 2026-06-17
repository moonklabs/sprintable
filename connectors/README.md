# Sprintable Agent Gateway — 주입 어댑터 계약

## 디렉토리 구조

```
connectors/
  sdk/                      # 레퍼런스 SDK (공통부 구현체)
    sprintable_sse.py       # Python SDK
    sprintable-sse.ts       # TypeScript/Bun SDK
    README.md
  hermes-sprintable/        # 카테고리 A: Hermes Agent 어댑터 (dev backend)
    plugin.yaml
    __init__.py
    adapter.py              # self-contained — inject allow-list vendored
    README.md
  hermes-sprintable-prod/   # 카테고리 A: Hermes Agent 어댑터 (prod backend)
    plugin.yaml             # SPRINTABLE_PROD_* 전용 self-contained 클론
    __init__.py
    adapter.py
    README.md
```

> 각 어댑터 폴더는 **자기완결**이다. fresh 온보딩은 폴더 하나만 복사하므로 sibling
> `sdk`를 import하면 ImportError로 미로딩된다(과거 P0). 주입 allow-list는 SDK가
> canonical 출처이되 어댑터에 vendor하며, `sdk/test_inject_allowlist.py`가 양측
> 동기를 가드한다.

---

## 어댑터 공통 계약 (5조)

모든 Sprintable 주입 어댑터는 다음 5개 조항을 준수해야 한다.

### ① SSE dial-out

```
GET /api/v2/agent/stream
Authorization: Bearer {AGENT_API_KEY}
Accept: text/event-stream
Last-Event-ID: {last_event_id}   # reconnect 커서 (첫 연결 시 생략)
```

- 에이전트가 서버에 아웃바운드 연결. 인바운드 도메인·웹훅·터널 불필요.
- SSE 프레임: `event:`, `id:`, `data:` (RFC 8895)
- heartbeat 이벤트 무시 (`event: heartbeat`)

### ② Turn 주입

```
data: {"event_id": "...", "recipient_seq": N, "is_backfill": bool,
       "payload": {"content": "...", "conversation_id": "...", "sender": {...}}}
```

- `payload.content`를 에이전트 세션에 새 턴으로 주입
- `is_backfill: true` 이벤트도 주입 후 ack (커서 전진 필요)
- `event_id` 기반 dedup 필수 (TTL 300s, max 1000 항목)

### ③ 응답

```
POST /api/v2/conversations/{conversation_id}/messages
Authorization: Bearer {AGENT_API_KEY}
{"content": "<response text>"}
```

- 에이전트 응답을 동일 conversation에 게시
- 응답 실패 시 재시도 가능 (idempotent)

### ④ Seq/Ack — 멱등 커서 전진

```
POST /api/v2/agent/events/ack
{"seq": N}
```

- 주입 성공 후 반드시 ack 발송
- contiguous-ack: 첫 seq 수신 시 `min(seq)-1`로 앵커링 후 연속 최고값만 ack
- `seq <= last_acked` 는 skip (멱등)
- ack 실패 시 재연결 시 backfill 재범람 위험 — 에러 로깅 후 계속 진행

### ⑤ 웹훅 skip

- 이 어댑터(dial-out)를 사용하는 경우 웹훅(Discord 등)은 **추가 레이어**
- 웹훅 ON 환경에서 dial-out도 실행하면 이중 수신 — 둘 중 하나만 활성화

---

## 어댑터 카테고리

| 카테고리 | 런타임 | 주입 방식 | 디렉토리 |
|----------|--------|-----------|----------|
| **A** | Hermes Agent — dev (Python) | `handle_message()` → 세션 주입 | `connectors/hermes-sprintable/` |
| **A** | Hermes Agent — prod (Python) | `handle_message()` → 세션 주입 (`SPRINTABLE_PROD_*`) | `connectors/hermes-sprintable-prod/` |
| **B** | Claude Code (MCP) | `notifications/claude/channel` emit | `packages/fakechat/server.ts` |
| **C** | 기타 (Codex, Gemini, Cursor, OpenClaw 등) | 런타임별 주입 API | `connectors/{runtime}-sprintable/` |

---

## 새 어댑터 작성 체크리스트

1. `connectors/sdk/sprintable_sse.py` (Python) 또는 `sprintable-sse.ts` (TS) SDK 활용
2. `on_message(ctx: MessageContext)` 콜백에 런타임별 주입 로직 구현
3. 5개 계약 조항 준수 확인
4. `connectors/{runtime}-sprintable/README.md` 작성 (설치 절차 포함)
5. PR → develop, CI green 필수

---

## 배포 절차 (공통)

```bash
# 모든 어댑터 공통
git pull origin develop
# 런타임별 설치 방법은 각 디렉토리 README 참고
```
