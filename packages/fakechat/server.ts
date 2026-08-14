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
// AGENT_API_KEY fallback for compatibility with existing .mcp.json configs.
// 04791bd9: 키 주입은 launch env(config/launch)가 담당 — plugin 프로세스↔workspace .mcp.json
// path 링크 부재로 코드 path-fallback(#1708 readMcpJsonEnv)은 futile이라 revert(process.env-only).
const API_KEY = (process.env.SPRINTABLE_API_KEY ?? process.env.AGENT_API_KEY ?? '').trim()
// 선생님 설계: webhook 구성된 에이전트는 fakechat SSE off(이중 주입 방지·discord가 처리).
// HAS_WEBHOOK="true"(launch env) → SSE 안 엶. webhook 없으면(오스카 등) on. harmless safety.
const HAS_WEBHOOK = (process.env.HAS_WEBHOOK ?? '').toLowerCase() === 'true'

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

// ── parent-death guard ───────────────────────────────────────────────────────
// stdin 은 호스트 세션(claude)이 물려준 MCP transport 파이프다. 세션이 죽으면 stdin 이
// EOF 를 맞는다. 이 가드가 없으면 아래 SSE 재연결 루프(while true)가 프로세스를 영원히
// 살려 둬 고아(PPID→1)로 남고, Agent Gateway 스트림 슬롯을 영구히 물어 재기동 뒤 "키당
// 동시 스트림" 한도를 포화시킨다(2026-08-10 10일 고아가 한 키를 통째로 막은 근본원인).
// 부모와 함께 죽는다.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
// 백스톱: stdin EOF 를 못 받은 채 init(PID 1)로 재양육되면(=완전 고아) 자진 종료.
// unref 로 이 타이머 자체가 프로세스를 살려 두진 않게 한다.
setInterval(() => { if (process.ppid === 1) process.exit(0) }, 15_000).unref()

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
      process.stderr.write(`[sprintable] ack seq=${seq}\n`)
    } else {
      process.stderr.write(`[sprintable] ack HTTP ${resp.status} seq=${seq}\n`)
    }
  } catch (e) {
    process.stderr.write(`[sprintable] ack error seq=${seq}: ${e}\n`)
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

  // recipient_seq for ack — data 최상위 우선, payload fallback. content 체크보다 먼저 계산해야
  // 아래 빈-content 분기에서도 ack할 수 있다(#2375 AC5).
  let seq = 0
  for (const cand of [data.recipient_seq, payload.recipient_seq]) {
    const n = Number(cand)
    if (Number.isFinite(n) && n > 0) {
      seq = n
      break
    }
  }

  const content = ((data.content ?? payload.content ?? '') as string).trim()
  if (!content) {
    // #2375 AC5 — 내용 없는 injectable 이벤트는 "전달 실패"가 아니라 "보일 것 없음"이다.
    // 예전엔 여기서 ack 없이 return해 seq가 영원히 미확인으로 남았다 — 재연결마다 backfill이
    // 같은 이벤트를 다시 보내는데, 그 backfill flood를 막으려던 ack 메커니즘(주석 참조) 자체가
    // 이 경로에서만 무력화돼 있었다(2026-07-31~08-01 dispatched 20건+ 영구 pending의 근본원인).
    // 서버가 content를 채운 뒤(notification_dispatch.py)로도 이 분기는 남는다 — 어떤 injectable
    // event가 정말로 텍스트를 안 실은 채 오는 경우의 안전망.
    if (seq > 0) await _sendAck(seq)
    return
  }

  const eventId = (data.event_id ?? payload.id ?? evId ?? crypto.randomUUID()) as string
  if (_isDuplicate(eventId)) return

  if (evId) _lastEventId = evId

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
    `[sprintable] inbound seq=${seq} conv=${conversationId} from=${senderName}: ${content.slice(0, 80)}\n`,
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
  if (!resp.ok) {
    // 게이트웨이는 동시 스트림 한도초과를 «상태코드»로 알린다 — per-key=429, global=503
    // (agent_gateway.py). 429 는 `Retry-After` 헤더 + `{error:{code,retry_after}}` 본문을
    // 싣는다. 서버가 준 retry_after 를 backoff 하한으로 삼아, 흔적만 남기고 슬롯을 계속
    // 되무는 재연결 대신 서버 계약대로 물러선다(throw → _runStream 지수 backoff).
    let retryAfter = Number(resp.headers.get('retry-after')) || 0
    let code = `HTTP ${resp.status}`
    try {
      const j = (await resp.json()) as { error?: { code?: string; retry_after?: number } }
      if (j?.error?.code) code = j.error.code
      if (retryAfter <= 0) {
        const ra = Number(j?.error?.retry_after)
        if (Number.isFinite(ra) && ra > 0) retryAfter = ra
      }
    } catch {}
    if (retryAfter > 0) _reconnectDelay = Math.max(_reconnectDelay, retryAfter * 1000)
    process.stderr.write(`[sprintable] stream refused: ${code} (HTTP ${resp.status}) — backoff ${_reconnectDelay}ms\n`)
    throw new Error(`stream refused: ${code} (HTTP ${resp.status})`)
  }
  if (!resp.body) throw new Error('no response body')

  process.stderr.write('[sprintable] SSE stream open\n')
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
  process.stderr.write('[sprintable] SSE stream closed\n')
}

async function _runStream(): Promise<void> {
  if (HAS_WEBHOOK) {
    process.stderr.write('[sprintable] webhook configured — SSE off\n')
    return
  }
  if (!API_KEY) {
    process.stderr.write('[sprintable] SPRINTABLE_API_KEY / AGENT_API_KEY not set — SSE disabled\n')
    return
  }

  while (true) {
    const start = Date.now()
    try {
      await _consumeStream()
    } catch (e) {
      process.stderr.write(`[sprintable] stream error: ${e}\n`)
    }
    if (Date.now() - start >= 60_000) _reconnectDelay = 2000
    process.stderr.write(`[sprintable] reconnecting in ${_reconnectDelay}ms\n`)
    await Bun.sleep(_reconnectDelay)
    _reconnectDelay = Math.min(_reconnectDelay * 2, 60_000)
  }
}

void _runStream()
