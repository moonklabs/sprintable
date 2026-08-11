// Kadir QA catch on PR #2968: package.json's test script referenced this file before it
// existed. Pins two things: (1) account resolution (config OR env dual fallback, matching
// this connector family's convention) — same pattern as OpenClaw's own acme-chat doc
// example test. (2) stopAccount actually aborts the SSE connection it started — the
// "declared dispose vs actual dispose" class of bug this session hit for real in #2578/S7
// QA (dispose() that didn't wire signal into fetch()), verified here against a real mock
// SSE server so this is a live behavioral proof, not just a type-shape check.
import { test, expect, beforeEach } from 'bun:test'
import { sprintablePlugin, CHANNEL_ID } from './channel.js'

type FakeConfig = { channels?: Record<string, unknown> }

test('resolveAccount reads apiKey/apiUrl from config when present', () => {
  const cfg: FakeConfig = {
    channels: { [CHANNEL_ID]: { apiKey: 'sk_live_from_config', apiUrl: 'https://custom.example.com' } },
  }
  const account = sprintablePlugin.config.resolveAccount(cfg as any, undefined)
  expect(account.apiKey).toBe('sk_live_from_config')
  expect(account.apiUrl).toBe('https://custom.example.com')
  expect(account.configured).toBe(true)
})

test('resolveAccount falls back to SPRINTABLE_API_KEY env when config is absent', () => {
  const prevKey = process.env.SPRINTABLE_API_KEY
  const prevUrl = process.env.SPRINTABLE_API_URL
  process.env.SPRINTABLE_API_KEY = 'sk_live_from_env'
  delete process.env.SPRINTABLE_API_URL
  try {
    const account = sprintablePlugin.config.resolveAccount({ channels: {} } as any, undefined)
    expect(account.apiKey).toBe('sk_live_from_env')
    expect(account.apiUrl).toBe('https://app.sprintable.ai')
    expect(account.configured).toBe(true)
  } finally {
    if (prevKey === undefined) delete process.env.SPRINTABLE_API_KEY
    else process.env.SPRINTABLE_API_KEY = prevKey
    if (prevUrl !== undefined) process.env.SPRINTABLE_API_URL = prevUrl
  }
})

test('inspectAccount reports unconfigured when no key is present anywhere', () => {
  const prevKey = process.env.SPRINTABLE_API_KEY
  const prevAgentKey = process.env.AGENT_API_KEY
  delete process.env.SPRINTABLE_API_KEY
  delete process.env.AGENT_API_KEY
  try {
    const result = sprintablePlugin.config.inspectAccount!({ channels: {} } as any, undefined) as {
      configured: boolean
      apiKeyStatus: string
    }
    expect(result.configured).toBe(false)
    expect(result.apiKeyStatus).toBe('missing')
  } finally {
    if (prevKey !== undefined) process.env.SPRINTABLE_API_KEY = prevKey
    if (prevAgentKey !== undefined) process.env.AGENT_API_KEY = prevAgentKey
  }
})

// ── gateway.stopAccount actually tears down the SSE connection ──────────────

function startMockSseServer() {
  let sawAbort = false
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.url.includes('/api/v2/agent/stream')) {
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            controller.enqueue(enc.encode(': connected\n\n'))
            req.signal.addEventListener('abort', () => {
              sawAbort = true
              try { controller.close() } catch {}
            })
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    },
  })
  return { server, sawAbort: () => sawAbort }
}

function fakeGatewayContext(apiUrl: string, abortSignal: AbortSignal) {
  return {
    account: { accountId: 'default', configured: true, apiKey: 'test-key', apiUrl },
    cfg: { agents: { accounts: {} } },
    abortSignal,
    log: { info: () => {}, warn: () => {} },
    setStatus: () => {},
    channelRuntime: {
      inbound: {
        buildContext: (_x: unknown) => ({}),
        dispatchReply: async (_x: unknown) => {},
      },
    },
  }
}

test('stopAccount aborts the SSE connection startAccount opened (real socket, not just a type check)', async () => {
  const { server, sawAbort } = startMockSseServer()
  const gatewayAbort = new AbortController()

  const startPromise = sprintablePlugin.gateway!.startAccount!(
    fakeGatewayContext(`http://localhost:${server.port}`, gatewayAbort.signal) as any,
  )

  // give the SSE connection a moment to actually open
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(sawAbort()).toBe(false)

  await sprintablePlugin.gateway!.stopAccount!(
    fakeGatewayContext(`http://localhost:${server.port}`, gatewayAbort.signal) as any,
  )

  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(sawAbort()).toBe(true)

  gatewayAbort.abort()
  await startPromise.catch(() => {})
  server.stop(true)
})
