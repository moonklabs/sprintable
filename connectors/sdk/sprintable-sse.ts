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

export type MessageContext = {
  content: string
  conversationId: string
  senderId: string
  senderName: string
  eventId: string
  seq: number
  isBackfill: boolean
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

export async function runSprintableSSE(opts: {
  apiUrl?: string
  apiKey: string
  onMessage: OnMessage
}): Promise<never> {
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

    const resp = await fetch(`${apiUrl}/api/v2/agent/stream`, { headers })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    if (!resp.body) throw new Error('no body')

    process.stderr.write('[sprintable-sse] stream open\n')
    backoffIdx = 0

    const reader = resp.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let evType = 'message', evId = '', dataLines: string[] = []

    while (true) {
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
              await onMessage(ctx)
              if (ctx.seq) await ack(ctx.seq)
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

    const content = ((data.content ?? payload.content ?? '') as string).trim()
    if (!content) return null

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
      content, conversationId, senderId, senderName, eventId, seq, isBackfill, raw: data,
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
    const t0 = Date.now()
    try {
      await consume()
    } catch (e) {
      process.stderr.write(`[sprintable-sse] error: ${e}\n`)
    }
    if (Date.now() - t0 >= 60_000) backoffIdx = 0
    const delay = RECONNECT_BACKOFF[Math.min(backoffIdx, RECONNECT_BACKOFF.length - 1)]
    process.stderr.write(`[sprintable-sse] reconnecting in ${delay}ms\n`)
    await Bun.sleep(delay)
    backoffIdx++
  }
}
