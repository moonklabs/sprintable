# Sprintable Gateway SSE SDK

Sprintable Agent Gateway 어댑터 작성을 위한 레퍼런스 SDK.
공통부(SSE 소비·파서·dedup·ack·backoff 재연결)를 제공하므로, 어댑터는 **주입부(`onMessage`)만 구현**하면 된다.

## 레퍼런스 어댑터

| 런타임 | 파일 | 주입 방식 |
|--------|------|-----------|
| Hermes (Python) | `connectors/hermes-sprintable/adapter.py` | `handle_message()` |
| Claude Code (TypeScript) | `packages/fakechat/server.ts` | `notifications/claude/channel` |

## Python SDK

```python
from connectors.sdk.sprintable_sse import SprintableSSEClient, MessageContext

async def inject(ctx: MessageContext) -> None:
    response = await my_agent.handle(ctx.content)
    await ctx.reply(response)

client = SprintableSSEClient(
    api_url=os.getenv("SPRINTABLE_API_URL"),
    api_key=os.getenv("AGENT_API_KEY"),
)
await client.run(inject)
```

## TypeScript SDK (Bun)

```typescript
import { runSprintableSSE } from './sprintable-sse'

await runSprintableSSE({
  apiUrl: process.env.SPRINTABLE_API_URL,
  apiKey: process.env.AGENT_API_KEY!,
  async onMessage(ctx) {
    const response = await myAgent.handle(ctx.content)
    await ctx.reply(response)
  },
})
```

## MessageContext 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| `content` | string | 메시지 텍스트 |
| `conversationId` | string | Sprintable conversation ID |
| `senderId` | string | 발신자 ID |
| `senderName` | string | 발신자 이름 |
| `eventId` | string | SSE event_id (dedup 기준) |
| `seq` | int | recipient_seq (ack 기준) |
| `isBackfill` | bool | backfill 여부 |
| `raw` | dict | 원본 SSE data payload |
| `reply(text)` | async fn | POST /conversations/{id}/messages |

## 새 어댑터 작성 가이드

[connectors/README.md](../README.md) 참고.
