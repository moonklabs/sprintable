// #2574 boundary test (same methodology as #2562's OpenCode mock-reply-path test): today's
// free-tier Google quota is fully exhausted (shared across gemini + pi, confirmed live — both
// hit 429 independently), so a real `pi` process can't complete an LLM turn. This proves the
// piece that's actually this extension's responsibility — SSE receive -> sendUserMessage
// injection, and agent_end -> reply POST — using a fake ExtensionAPI (no real pi binary) and a
// real mock SSE server (no real Sprintable backend, but real sockets/HTTP). Whether the
// underlying model can respond is explicitly out of scope, same boundary PO drew for #2562/#2563.
import { test, expect } from 'bun:test'
import sprintableExtension from './index.js'

type FakeApi = {
  handlers: Record<string, ((event: unknown) => void)[]>
  on(event: string, handler: (event: unknown) => void): void
  sentMessages: { content: string; options: unknown }[]
  sendUserMessage(content: string, options?: unknown): void
  fire(event: string, payload: unknown): void
}

function makeFakeApi(): FakeApi {
  const handlers: Record<string, ((event: unknown) => void)[]> = {}
  return {
    handlers,
    on(event, handler) {
      ;(handlers[event] ??= []).push(handler)
    },
    sentMessages: [],
    sendUserMessage(content, options) {
      this.sentMessages.push({ content, options })
    },
    fire(event, payload) {
      for (const h of handlers[event] ?? []) h(payload)
    },
  }
}

function startMockSseServer(dataLine: string) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.url.includes('/api/v2/agent/stream')) {
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            controller.enqueue(enc.encode(`event: message\nid: 1\ndata: ${dataLine}\n\n`))
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
      if (req.url.includes('/messages') && req.method === 'POST') {
        return new Response('{}', { status: 200 })
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    },
  })
  return server
}

test('no-op when SPRINTABLE_API_KEY is unset (AC3)', () => {
  const prevKey = process.env.SPRINTABLE_API_KEY
  const prevAgentKey = process.env.AGENT_API_KEY
  delete process.env.SPRINTABLE_API_KEY
  delete process.env.AGENT_API_KEY
  try {
    const api = makeFakeApi()
    sprintableExtension(api as never)
    expect(Object.keys(api.handlers)).toHaveLength(0)
  } finally {
    if (prevKey !== undefined) process.env.SPRINTABLE_API_KEY = prevKey
    if (prevAgentKey !== undefined) process.env.AGENT_API_KEY = prevAgentKey
  }
})

test('inbound SSE message injects via sendUserMessage(deliverAs: steer), then agent_end reply posts back', async () => {
  const server = startMockSseServer(JSON.stringify({
    event_type: 'dispatched', event_id: 'evt-1',
    content: 'hello from sprintable',
    payload: { conversation_id: 'conv-test-1', sender: { id: 's1', name: 'tester' } },
  }))
  process.env.SPRINTABLE_API_KEY = 'test-key'
  process.env.SPRINTABLE_API_URL = `http://localhost:${server.port}`

  const api = makeFakeApi()
  sprintableExtension(api as never)
  expect(Object.keys(api.handlers).sort()).toEqual(['agent_end', 'session_shutdown', 'session_start'])

  api.fire('session_start', { type: 'session_start', reason: 'startup' })

  // give the SSE connection + onMessage callback a moment to actually run
  await new Promise((resolve) => setTimeout(resolve, 300))

  expect(api.sentMessages).toHaveLength(1)
  expect(api.sentMessages[0].content).toBe('hello from sprintable')
  expect(api.sentMessages[0].options).toEqual({ deliverAs: 'steer' })

  // Simulate agent_end with a mocked assistant response — bypasses the real LLM entirely,
  // exercising the exact same ctx.reply() code path index.ts's agent_end handler calls.
  let replyReceived: string | null = null
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes('/messages') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      replyReceived = body.content
      return new Response('{}', { status: 200 })
    }
    return origFetch(url as never, init)
  }) as typeof fetch

  try {
    api.fire('agent_end', {
      type: 'agent_end',
      messages: [
        { role: 'user', content: 'hello from sprintable', timestamp: Date.now() },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'MOCKED_MODEL_RESPONSE: pi extension reply path confirmed working' }],
          api: 'anthropic-messages', provider: 'anthropic', model: 'test',
          usage: { totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop', timestamp: Date.now(),
        },
      ],
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
  } finally {
    globalThis.fetch = origFetch
  }

  expect(replyReceived as string | null).toBe('MOCKED_MODEL_RESPONSE: pi extension reply path confirmed working')

  api.fire('session_shutdown', { type: 'session_shutdown', reason: 'quit' })
  server.stop(true)
})
