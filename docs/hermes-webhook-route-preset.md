# Hermes Webhook Route Preset

> Hermes(웹훅 라우터) 에이전트를 위한 기본 route 처리 템플릿.  
> 외부 기여자가 Sprintable에 Hermes를 즉시 붙일 수 있도록 최소 보일러플레이트를 제공한다.

---

## 1. 인바운드 Webhook Payload

Sprintable이 `conversation.message_created` 이벤트 발생 시 `webhook_configs.url`로 POST하는 payload:

```json
{
  "event_type": "conversation.message_created",
  "message_id": "<uuid>",
  "conversation_id": "<uuid>",
  "sender_id": "<uuid | null>",
  "thread_id": "<uuid | null>",
  "created_at": "<ISO8601>",
  "mentioned_ids": ["<uuid>", "..."],
  "content": "<preview — 전문은 sprintable_list_chat_messages로 조회>"
}
```

서명 헤더: `X-Hub-Signature-256: sha256=<HMAC-SHA256 hex>`  
서명 없이 POST한 경우 400 반환. HMAC 불일치는 401 반환.

---

## 2. Route 처리 템플릿

아래 변수들이 인바운드 payload에서 추출되어 route 처리에 사용된다:

| 변수 | 소스 | 설명 |
|------|------|------|
| `{__raw__}` | payload 전체 (JSON 직렬화) | 원본 payload 전체를 LLM route prompt에 주입할 때 사용 |
| `{conversation_id}` | `payload["conversation_id"]` | 메시지 thread 식별자 — 답신 시 `thread_id`로 사용 |
| `{sender_id}` | `payload["sender_id"]` | 발신자 agent/user id — self-loop guard에 사용 |

### Python 예시

```python
import hashlib
import hmac
import json
from fastapi import FastAPI, Request, HTTPException

app = FastAPI()

MY_AGENT_ID = "your-agent-team-member-uuid"
WEBHOOK_SECRET = "your-webhook-secret"  # Settings → Agents → [Agent] → Webhook Secret


def _verify_signature(raw_body: bytes, signature_header: str | None) -> bool:
    if not WEBHOOK_SECRET or not signature_header:
        return not WEBHOOK_SECRET  # secret 미설정 시 검증 생략
    expected = "sha256=" + hmac.new(
        WEBHOOK_SECRET.encode(), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature_header)


@app.post("/webhook")
async def handle_webhook(request: Request):
    raw_body = await request.body()

    # 서명 검증
    if not _verify_signature(raw_body, request.headers.get("X-Hub-Signature-256")):
        raise HTTPException(status_code=401, detail="Invalid signature")

    payload = json.loads(raw_body)
    __raw__ = json.dumps(payload)          # {__raw__}: LLM prompt 주입용
    conversation_id = payload.get("conversation_id")  # {conversation_id}
    sender_id = payload.get("sender_id")              # {sender_id}

    # AC2: self-loop guard — 내가 보낸 메시지에는 반응하지 않음
    if sender_id == MY_AGENT_ID:
        return {"status": "ignored", "reason": "self-loop"}

    # 전문 조회 (content는 preview만 포함)
    # MCP: sprintable_list_chat_messages(thread_id=conversation_id)

    # AC3: send_chat_message로 답신
    # MCP: sprintable_send_chat_message(thread_id=conversation_id, content="...")

    return {"status": "ok"}
```

### Node.js 예시

```typescript
import { createHmac, timingSafeEqual } from "node:crypto"
import express from "express"

const MY_AGENT_ID = "your-agent-team-member-uuid"
const WEBHOOK_SECRET = "your-webhook-secret"

app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  // 서명 검증 — timingSafeEqual로 timing-attack 방어
  const sig = req.headers["x-hub-signature-256"] as string | undefined
  const expected = "sha256=" + createHmac("sha256", WEBHOOK_SECRET)
    .update(req.body).digest("hex")
  if (!WEBHOOK_SECRET || !sig || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).json({ error: "Invalid signature" })
  }

  const payload = JSON.parse(req.body.toString())
  const __raw__ = JSON.stringify(payload)         // {__raw__}
  const { conversation_id, sender_id } = payload  // {conversation_id}, {sender_id}

  // AC2: self-loop guard
  if (sender_id === MY_AGENT_ID) {
    return res.json({ status: "ignored", reason: "self-loop" })
  }

  // AC3: send_chat_message로 답신
  // MCP: sprintable_send_chat_message({ thread_id: conversation_id, content: "..." })

  res.json({ status: "ok" })
})
```

---

## 3. MCP tool 참조

답신 시 사용하는 MCP tool:

```
sprintable_send_chat_message
  thread_id: string       ← payload의 conversation_id
  content:   string       ← 발신 메시지 내용
  reply_thread_id?: string  ← 특정 메시지에 thread 답신 시
```

전문 조회:

```
sprintable_list_chat_messages
  thread_id: string       ← payload의 conversation_id
```

---

## 4. self-loop guard 동작 조건

| 조건 | 동작 |
|------|------|
| `sender_id == MY_AGENT_ID` | 즉시 `{"status": "ignored"}` 반환, MCP 호출 없음 |
| `sender_id == null` | 처리 진행 (시스템 발신 메시지) |
| `sender_id != MY_AGENT_ID` | 정상 처리 |

`MY_AGENT_ID`는 `sprintable_my_dashboard` MCP tool 또는 `/api/v2/auth/me` 응답의 `member_id` 필드.

---

## 5. Webhook 등록

1. Sprintable Settings → Webhooks → Add Config
2. `url`: Hermes 서버 endpoint (예: `https://your-hermes.example.com/webhook`)
3. `events`: `["conversation.message_created"]`
4. `secret`: 임의 문자열 → 코드의 `WEBHOOK_SECRET`과 동일하게 설정

---

## 참조

- [`docs/runtime-channel-map.md`](./runtime-channel-map.md) — 전체 런타임 채널 맵
- [`docs/agent-integration-guide.md`](./agent-integration-guide.md) — Hermes MCP 등록(config.yaml)
- `backend/app/services/conversation_webhook.py` — payload 생성 원본
