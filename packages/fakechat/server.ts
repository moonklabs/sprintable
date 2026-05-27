#!/usr/bin/env bun
/**
 * E-FAKECHAT-INTEG:S3 — MCP stdio shim.
 *
 * Bun HTTP 서버 제거. Sprintable 백엔드 WS에 클라이언트로 연결.
 * 수신: WS 메시지 → deliver() → mcp.notification (Claude Code channel)
 * 송신: reply 도구 → WS send
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { mkdirSync, statSync, copyFileSync } from 'fs'
import { homedir } from 'os'
import { join, extname, basename } from 'path'

const STATE_DIR = join(homedir(), '.claude', 'channels', 'fakechat')
const OUTBOX_DIR = join(STATE_DIR, 'outbox')

const SPRINTABLE_WS_BASE = (process.env.SPRINTABLE_WS_URL ?? 'ws://localhost:8000').replace(/\/$/, '')
const SPRINTABLE_AGENT_ID = process.env.SPRINTABLE_AGENT_ID ?? ''
const SPRINTABLE_API_KEY = process.env.SPRINTABLE_API_KEY ?? ''

type InboundMeta = {
  threadId: string
  replyCallbackUrl: string
  replyCallbackApiKey: string
}

// message_id → inbound relay 메타 (역방향 relay에 사용)
const inboundMeta = new Map<string, InboundMeta>()
let latestInboundMeta: InboundMeta | undefined

const mcp = new Server(
  { name: 'fakechat', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: `The sender connects via Sprintable backend WebSocket. Anything you want them to see must go through the reply tool — your transcript output never reaches them.\n\nMessages arrive as <channel source="fakechat" chat_id="web" message_id="...">. If the tag has a file_path attribute, Read that file — it is an upload. Reply with the reply tool.`,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message to the Sprintable backend WebSocket. Pass reply_to for quote-reply, files for attachments.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          reply_to: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['text'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a previously sent message.',
      inputSchema: {
        type: 'object',
        properties: { message_id: { type: 'string' }, text: { type: 'string' } },
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
        const replyTo = args.reply_to as string | undefined
        const files = (args.files as string[] | undefined) ?? []

        mkdirSync(OUTBOX_DIR, { recursive: true })
        let fileInfo: { name: string } | undefined
        if (files[0]) {
          const f = files[0]
          const st = statSync(f)
          if (st.size > 50 * 1024 * 1024) throw new Error(`file too large: ${f}`)
          const ext = extname(f).toLowerCase()
          const out = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
          copyFileSync(f, join(OUTBOX_DIR, out))
          fileInfo = { name: basename(f) }
        }

        const payload: Record<string, unknown> = { content: text }
        if (replyTo) payload.reply_to = replyTo
        if (fileInfo) payload.file_name = fileInfo.name
        _wsSend(JSON.stringify(payload))

        return { content: [{ type: 'text', text: 'sent' }] }
      }
      case 'edit_message': {
        _wsSend(JSON.stringify({ type: 'edit', id: args.message_id as string, text: args.text as string }))
        return { content: [{ type: 'text', text: 'ok' }] }
      }
      default:
        return { content: [{ type: 'text', text: `unknown: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `${req.params.name}: ${err instanceof Error ? err.message : err}` }], isError: true }
  }
})

await mcp.connect(new StdioServerTransport())

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
        chat_id: 'web', message_id: id, user: 'web', ts: new Date().toISOString(),
        ...(file ? { file_path: file.path } : {}),
        ...(meta?.thread_id ? { thread_id: meta.thread_id } : {}),
      },
    },
  })
}

// WebSocket 클라이언트 — Sprintable 백엔드 WS 허브에 연결
let _ws: WebSocket | null = null
let _reconnectDelay = 1000  // exponential backoff 시작값 (ms)

function _wsSend(data: string): void {
  if (_ws?.readyState === WebSocket.OPEN) {
    _ws.send(data)
  } else {
    process.stderr.write('fakechat: WS not connected — message dropped\n')
  }
}

function _connectWs(): void {
  if (!SPRINTABLE_AGENT_ID) {
    process.stderr.write('fakechat: SPRINTABLE_AGENT_ID not set — WS disabled\n')
    return
  }

  const url = new URL(`${SPRINTABLE_WS_BASE}/ws/chat/${SPRINTABLE_AGENT_ID}`)
  if (SPRINTABLE_API_KEY) url.searchParams.set('api_key', SPRINTABLE_API_KEY)

  // API key 마스킹 (로그 노출 방지)
  const logUrl = SPRINTABLE_API_KEY
    ? url.toString().replace(SPRINTABLE_API_KEY, '***')
    : url.toString()
  process.stderr.write(`fakechat: connecting to ${logUrl}\n`)

  _ws = new WebSocket(url.toString())

  _ws.onopen = () => {
    process.stderr.write('fakechat: WS connected\n')
    _reconnectDelay = 1000  // 성공 시 backoff 리셋
  }

  _ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(String(event.data)) as {
        id?: string
        content?: string
        sender_id?: string
        sender_name?: string
        ts?: string
      }
      if (msg.id && msg.content) {
        deliver(msg.id, msg.content)
      }
    } catch {}
  }

  _ws.onclose = () => {
    process.stderr.write(`fakechat: WS closed — reconnecting in ${_reconnectDelay}ms\n`)
    setTimeout(() => {
      _reconnectDelay = Math.min(_reconnectDelay * 2, 30_000)  // max 30s cap
      _connectWs()
    }, _reconnectDelay)
  }

  _ws.onerror = () => {
    process.stderr.write('fakechat: WS error\n')
  }
}

_connectWs()
