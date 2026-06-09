#!/usr/bin/env bun
/**
 * E-INJECT-ADAPTERS:Phase0 — CC 주입 어댑터 (SSE dial-out).
 *
 * Sprintable Agent Gateway /api/v2/agent/stream (SSE) 소비 → deliver() →
 * notifications/claude/channel emit (모델 가시). hermes adapter 동형.
 *
 * 수신: SSE /api/v2/agent/stream → deliver() → mcp.notification (channel)
 * 송신: reply 도구 → POST /api/v2/conversations/{id}/messages
 * ack:  주입 후 POST /api/v2/agent/events/ack {seq} — backfill flood 방지
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { isInjectableEventType } from './inject-allowlist'

const API_URL = (
  process.env.SPRINTABLE_API_URL ?? 'https://sprintable-backend-dev-57iommnikq-du.a.run.app'
).replace(/\/$/, '')
// AGENT_API_KEY fallback for compatibility with existing .mcp.json configs
const API_KEY = (process.env.SPRINTABLE_API_KEY ?? process.env.AGENT_API_KEY ?? '').trim()

type InboundMeta = {
  threadId: string
  replyCallbackUrl: string
  replyCallbackApiKey: string
}

const inboundMeta = new Map<string, InboundMeta>()
let latestInboundMeta: InboundMeta | undefined

// ── MCP server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'fakechat', version: '0.2.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions:
      'Sprintable 게이트웨이 이벤트가 <channel source="fakechat"> 블록으로 도착한다. ' +
      '응답은 reply 도구를 사용하는.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'POST /api/v2/conversations/{id}/messages. Requires an active conversation.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a previously sent message.',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['message_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const text = args.text as string
        const meta = latestInboundMeta
        if (!meta?.replyCallbackUrl) throw new Error('no active conversation')
        const resp = await fetch(meta.replyCallbackUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${meta.replyCallbackApiKey}`,
            'x-agent-api-key': meta.replyCallbackApiKey,
          },
          body: JSON.stringify({ content: text }),
        })
        if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text().catch(() => '')}`)
        return { content: [{ type: 'text', text: 'sent' }] }
      }
      case 'edit_message': {
        // no WS anymore — best-effort via REST if endpoint exists
        return { content: [{ type: 'text', text: 'ok (edit not supported in SSE mode)' }] }
      }
      default:
        return {
          content: [{ type: 'text', text: `unknown: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${req.params.name}: ${err instanceof Error ? err.message : err}` }],
      isError: true,
    }
  }
})

await mcp.connect(new StdioServerTransport())

// ── channel deliver ──────────────────────────────────────────────────────────

function deliver(
  id: string,
  text: string,
  file?: { path: string; name: string },
  meta?: { thread_id?: string; reply_callback_url?: string; reply_callback_api_key?: string },
): void {
  if (meta?.thread_id && meta?.reply_callback_url && meta?.reply_callback_api_key) {
    const m: InboundMeta = {
      threadId: meta.thread_id,
      replyCallbackUrl: meta.reply_callback_url,
      replyCallbackApiKey: meta.reply_callback_api_key,
    }
    inboundMeta.set(id, m)
    latestInboundMeta = m
  }

  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text || `(${file?.name ?? 'attachment'})`,
      meta: {
        chat_id: meta?.thread_id ?? 'sprintable',
        message_id: id,
        user: 'sprintable',
        ts: new Date().toISOString(),
        ...(file ? { file_path: file.path } : {}),
        ...(meta?.thread_id ? { thread_id: meta.thread_id } : {}),
      },
    },
  })
}

// ── SSE dial-out ─────────────────────────────────────────────────────────────

let _lastEventId = ''
let _lastAcked = 0
let _reconnectDelay = 2000
const _seen = new Map<string, number>()

function _isDuplicate(eventId: string): boolean {
  const now = Date.now()
  if (_seen.size > 1000) {
    for (const [k, v] of _seen) {
      if (now - v > 300_000) _seen.delete(k)
    }
  }
  if (_seen.has(eventId)) return true
  _seen.set(eventId, now)
  return false
}

async function _sendAck(seq: number): Promise<void> {
  if (seq <= _lastAcked) return
  try {
    const resp = await fetch(`${API_URL}/api/v2/agent/events/ack`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'x-agent-api-key': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ seq }),
    })
    if (resp.ok) {
      _lastAcked = seq
      process.stderr.write(`[fakechat] ack seq=${seq}\n`)
    } else {
      process.stderr.write(`[fakechat] ack HTTP ${resp.status} seq=${seq}\n`)
    }
  } catch (e) {
    process.stderr.write(`[fakechat] ack error seq=${seq}: ${e}\n`)
  }
}

async function _onEvent(evType: string, evId: string, dataStr: string): Promise<void> {
  if (evType === 'heartbeat') return

  let data: Record<string, unknown>
  try {
    data = JSON.parse(dataStr)
  } catch {
    return
  }

  // event shape: content/conversation_id/sender/recipient_seq top-level
  // payload 서브오브젝트도 지원 (conversation.message_created 등)
  const payload =
    (typeof data.payload === 'object' && data.payload !== null
      ? data.payload
      : {}) as Record<string, unknown>

  // E-CHAT-CMD S9: allowlist 밖 event_type 은 content 체크 전에 드롭(sprintable_sse.py:157 동형).
  // fakechat 가 유일하게 이 게이트가 없어 FYI 이벤트(status_changed/file_conflict 등)가 content 만
  // 있으면 세션에 주입되던 보안 갭을 닫는다.
  if (!isInjectableEventType(data, payload)) return

  const content = ((data.content ?? payload.content ?? '') as string).trim()
  if (!content) return

  const eventId = (data.event_id ?? payload.id ?? evId ?? crypto.randomUUID()) as string
  if (_isDuplicate(eventId)) return

  if (evId) _lastEventId = evId

  // recipient_seq for ack — data 최상위 우선, payload fallback
  let seq = 0
  for (const cand of [data.recipient_seq, payload.recipient_seq]) {
    const n = Number(cand)
    if (Number.isFinite(n) && n > 0) {
      seq = n
      break
    }
  }

  const conversationId = (
    payload.conversation_id ??
    payload.thread_id ??
    data.conversation_id ??
    ''
  ) as string

  const sender =
    (typeof payload.sender === 'object' && payload.sender !== null
      ? payload.sender
      : {}) as Record<string, unknown>
  const senderName = String(sender.name ?? data.sender_id ?? 'sprintable')

  const meta =
    conversationId
      ? {
          thread_id: conversationId,
          reply_callback_url: `${API_URL}/api/v2/conversations/${conversationId}/messages`,
          reply_callback_api_key: API_KEY,
        }
      : undefined

  process.stderr.write(
    `[fakechat] inbound seq=${seq} conv=${conversationId} from=${senderName}: ${content.slice(0, 80)}\n`,
  )

  deliver(eventId, content, undefined, meta)

  if (seq > 0) await _sendAck(seq)
}

async function _consumeStream(): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    'x-agent-api-key': API_KEY,
    Accept: 'text/event-stream',
    'Cache-Control': 'no-cache',
  }
  if (_lastEventId) headers['Last-Event-ID'] = _lastEventId

  const resp = await fetch(`${API_URL}/api/v2/agent/stream`, { headers })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  if (!resp.body) throw new Error('no response body')

  process.stderr.write('[fakechat] SSE stream open\n')
  _reconnectDelay = 2000 // 성공 시 backoff 리셋

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let evType = 'message'
  let evId = ''
  let dataLines: string[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    const lines = buf.split('\n')
    buf = lines.pop() ?? ''

    for (const raw of lines) {
      const line = raw.replace(/\r$/, '')
      if (line === '') {
        if (dataLines.length) {
          await _onEvent(evType, evId, dataLines.join('\n'))
        }
        evType = 'message'
        evId = ''
        dataLines = []
      } else if (line.startsWith(':')) {
        // comment — skip
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
  process.stderr.write('[fakechat] SSE stream closed\n')
}

async function _runStream(): Promise<void> {
  if (!API_KEY) {
    process.stderr.write('[fakechat] SPRINTABLE_API_KEY / AGENT_API_KEY not set — SSE disabled\n')
    return
  }

  while (true) {
    const start = Date.now()
    try {
      await _consumeStream()
    } catch (e) {
      process.stderr.write(`[fakechat] stream error: ${e}\n`)
    }
    if (Date.now() - start >= 60_000) _reconnectDelay = 2000
    process.stderr.write(`[fakechat] reconnecting in ${_reconnectDelay}ms\n`)
    await Bun.sleep(_reconnectDelay)
    _reconnectDelay = Math.min(_reconnectDelay * 2, 60_000)
  }
}

void _runStream()
