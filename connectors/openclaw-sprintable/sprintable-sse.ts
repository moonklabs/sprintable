/**
 * Sprintable Gateway SSE Reference SDK — TypeScript/Bun
 *
 * 공통부: SSE 소비 · 파서 · dedup · ack(contiguous, min-1 앵커링) · backoff 재연결.
 * 어댑터는 `onMessage` 콜백(주입부)만 구현하면 된다.
 *
 * @example
 * ```ts
 * import { runSprintableSSE } from './sprintable-sse'
 *
 * await runSprintableSSE({
 *   apiUrl: 'https://sprintable-backend-dev-57iommnikq-du.a.run.app',
 *   apiKey: process.env.AGENT_API_KEY!,
 *   async onMessage(ctx) {
 *     // runtime-specific injection
 *     const response = await myAgent.handle(ctx.content)
 *     await ctx.reply(response)
 *   },
 * })
 * ```
 */

/**
 * 일반 첨부(이미지 포함 전체) — #2578: Python SDK(#2568)만 첨부 정규화를 갖고 있었고
 * 이 TS SDK엔 처음부터 없었다(images 개념 자체도 없음 — 그건 별개의, 여전히 남은 갭).
 * 백엔드는 payload.attachments에 이미 이걸 싣는다(mime 필터 없음 — 첨부는 전 타입 대상).
 */
export type MessageAttachment = {
  url: string
  name: string
  contentType: string
  size: number | null
  assetId: string
}

export type MessageContext = {
  content: string
  conversationId: string
  senderId: string
  senderName: string
  eventId: string
  seq: number
  isBackfill: boolean
  attachments: MessageAttachment[]
  raw: Record<string, unknown>
  /** POST /api/v2/conversations/{id}/messages */
  reply(text: string): Promise<void>
}

export type OnMessage = (ctx: MessageContext) => Promise<void>

const DEFAULT_API_URL = 'https://sprintable-backend-dev-57iommnikq-du.a.run.app'
const RECONNECT_BACKOFF = [2000, 5000, 10000, 30000, 60000]
const DEDUP_MAX = 1000
const DEDUP_TTL_MS = 300_000

function _authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'x-agent-api-key': apiKey }
}

/** #2578: Python _normalize_attachments 이식. mime 필터 없음 — 전 타입 대상. */
export function normalizeAttachments(value: unknown): MessageAttachment[] {
  if (!Array.isArray(value)) return []
  const out: MessageAttachment[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const url = String(rec.url ?? '').trim()
    if (!url) continue
    const rawSize = rec.size
    const size = typeof rawSize === 'number' && Number.isFinite(rawSize) ? rawSize : null
    out.push({
      url,
      name: String(rec.name ?? ''),
      contentType: String(rec.content_type ?? ''),
      size,
      assetId: String(rec.asset_id ?? ''),
    })
  }
  return out
}

/**
 * #2578 AC1: 첨부 존재+회수 경로(asset text API)를 에이전트가 알 수 있게 텍스트로 안내.
 * asset_id가 있으면(정상 케이스) 그 경로를, 없으면(레거시/미등록) url을 안내.
 */
export function renderAttachmentNotice(attachments: MessageAttachment[]): string {
  const lines = attachments.map((a) => {
    const label = a.name || a.url
    return a.assetId
      ? `- ${label} (${a.contentType || 'unknown type'}) — 본문 회수: GET /api/v2/assets/${a.assetId}/text`
      : `- ${label} (${a.contentType || 'unknown type'}) — url: ${a.url}`
  })
  return `[첨부 ${attachments.length}건]\n${lines.join('\n')}\n[/첨부]`
}

export async function runSprintableSSE(opts: {
  apiUrl?: string
  apiKey: string
  onMessage: OnMessage
  signal?: AbortSignal
}): Promise<void> {
  const { apiKey, onMessage } = opts
  const apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, '')

  let lastEventId = ''
  let lastAcked = 0
  let backoffIdx = 0
  const seen = new Map<string, number>()

  function isDup(eventId: string): boolean {
    const now = Date.now()
    if (seen.size > DEDUP_MAX) {
      for (const [k, v] of seen) if (now - v > DEDUP_TTL_MS) seen.delete(k)
    }
    if (seen.has(eventId)) return true
    seen.set(eventId, now)
    return false
  }

  async function ack(seq: number): Promise<void> {
    if (seq <= lastAcked) return
    try {
      const resp = await fetch(`${apiUrl}/api/v2/agent/events/ack`, {
        method: 'POST',
        headers: { ..._authHeaders(apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({ seq }),
      })
      if (resp.ok) {
        lastAcked = seq
        process.stderr.write(`[sprintable-sse] ack seq=${seq}\n`)
      }
    } catch (e) {
      process.stderr.write(`[sprintable-sse] ack error seq=${seq}: ${e}\n`)
    }
  }

  async function consume(): Promise<void> {
    const headers: Record<string, string> = {
      ..._authHeaders(apiKey),
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
    }
    if (lastEventId) headers['Last-Event-ID'] = lastEventId

    const resp = await fetch(`${apiUrl}/api/v2/agent/stream`, { headers, signal: opts.signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    if (!resp.body) throw new Error('no body')

    process.stderr.write('[sprintable-sse] stream open\n')
    backoffIdx = 0

    const reader = resp.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let evType = 'message', evId = '', dataLines: string[] = []

    while (true) {
      if (opts.signal?.aborted) {
        await reader.cancel()
        return
      }
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      for (const raw of lines) {
        const line = raw.replace(/\r$/, '')
        if (line === '') {
          if (dataLines.length) {
            const ctx = await parseEvent(evType, evId, dataLines.join('\n'), apiUrl, apiKey)
            if (ctx) {
              process.stderr.write(
                `[sprintable-sse] inbound seq=${ctx.seq} conv=${ctx.conversationId}: ${ctx.content.slice(0, 80)}\n`
              )
              // story #2580 — isDup() claims ctx.eventId *before* onMessage runs (needed to
              // survive a same-event redelivery arriving mid-processing). If onMessage throws
              // (reply POST failed, LLM call failed, etc.), the event never gets acked, so the
              // backend backfills the identical event_id on reconnect — but isDup() would keep
              // rejecting it as already-seen forever (bounded only by the opportunistic TTL
              // sweep at DEDUP_MAX overflow), silently losing the message. Same defect class as
              // codex PR#7's claim-before-POST bug — release the claim on failure so redelivery
              // can retry, same as codex's `_release_claim`.
              try {
                await onMessage(ctx)
                if (ctx.seq) await ack(ctx.seq)
              } catch (e) {
                seen.delete(ctx.eventId)
                throw e
              }
            }
          }
          evType = 'message'; evId = ''; dataLines = []
        } else if (line.startsWith(':')) {
          // comment
        } else if (line.startsWith('event:')) {
          evType = line.slice(6).trim()
        } else if (line.startsWith('id:')) {
          evId = line.slice(3).trim()
        } else if (line.startsWith('data:')) {
          const v = line.slice(5)
          dataLines.push(v.startsWith(' ') ? v.slice(1) : v)
        }
      }
    }
    process.stderr.write('[sprintable-sse] stream closed\n')
  }

  async function parseEvent(
    evType: string, evId: string, dataStr: string,
    apiUrl: string, apiKey: string,
  ): Promise<MessageContext | null> {
    if (evType === 'heartbeat') return null
    let data: Record<string, unknown>
    try { data = JSON.parse(dataStr) } catch { return null }

    const payload = (
      typeof data.payload === 'object' && data.payload !== null ? data.payload : {}
    ) as Record<string, unknown>

    let content = ((data.content ?? payload.content ?? '') as string).trim()
    const attachments = normalizeAttachments(data.attachments ?? payload.attachments)
    if (!content && attachments.length === 0) return null
    // #2578 AC1/AC2: 첨부가 있으면 안내 블록을 content에 병합 — 어댑터마다 따로 렌더하게
    // 하지 않고 SDK 단일 지점에서 처리(Python SDK #2568과 동형, 어댑터 코드 수정 0으로 전파).
    if (attachments.length > 0) {
      const notice = renderAttachmentNotice(attachments)
      content = content ? `${content}\n\n${notice}` : notice
    }

    const eventId = String(data.event_id ?? payload.id ?? evId ?? crypto.randomUUID())
    if (isDup(eventId)) return null
    if (evId) lastEventId = evId

    let seq = 0
    for (const cand of [data.recipient_seq, payload.recipient_seq]) {
      const n = Number(cand)
      if (Number.isFinite(n) && n > 0) { seq = n; break }
    }

    const conversationId = String(
      payload.conversation_id ?? payload.thread_id ?? data.conversation_id ?? ''
    )
    const sender = (
      typeof payload.sender === 'object' && payload.sender !== null ? payload.sender : {}
    ) as Record<string, unknown>
    const senderId = String(sender.id ?? data.sender_id ?? 'sprintable')
    const senderName = String(sender.name ?? senderId)
    const isBackfill = Boolean(data.is_backfill)

    const replyUrl = conversationId
      ? `${apiUrl}/api/v2/conversations/${conversationId}/messages`
      : ''

    return {
      content, conversationId, senderId, senderName, eventId, seq, isBackfill, attachments, raw: data,
      async reply(text: string) {
        if (!replyUrl) throw new Error('no conversation_id')
        const r = await fetch(replyUrl, {
          method: 'POST',
          headers: { ..._authHeaders(apiKey), 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text }),
        })
        if (!r.ok) throw new Error(`reply HTTP ${r.status}`)
      },
    }
  }

  // main loop
  while (true) {
    if (opts.signal?.aborted) return
    const t0 = Date.now()
    try {
      await consume()
    } catch (e) {
      if (opts.signal?.aborted) return
      process.stderr.write(`[sprintable-sse] error: ${e}\n`)
    }
    if (opts.signal?.aborted) return
    if (Date.now() - t0 >= 60_000) backoffIdx = 0
    const delay = RECONNECT_BACKOFF[Math.min(backoffIdx, RECONNECT_BACKOFF.length - 1)]
    process.stderr.write(`[sprintable-sse] reconnecting in ${delay}ms\n`)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay)
      opts.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
    backoffIdx++
  }
}
