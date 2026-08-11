// #2578: 웹 첨부가 에이전트 SSE 주입에 안 실림 — 회귀 방지 pin (TS side).
// Python SDK(#2568)의 test_attachment_injection.py와 동형 커버리지. bun:test — 이 디렉토리는
// package.json 없는 reference SDK라 부속 Python 테스트들과 같은 무설정 관례를 따른다.
import { test, expect } from 'bun:test'
import { normalizeAttachments, renderAttachmentNotice, runSprintableSSE, type MessageContext } from './sprintable-sse'

const ATTACHMENT = {
  url: 'https://storage.googleapis.com/bucket/notes.md',
  name: 'notes.md',
  content_type: 'text/markdown',
  size: 1234,
  asset_id: '5c1e1e1e-1111-2222-3333-444455556666',
}

test('normalizeAttachments has no mime filter (unlike an images-style filter)', () => {
  const out = normalizeAttachments([ATTACHMENT])
  expect(out).toHaveLength(1)
  expect(out[0].name).toBe('notes.md')
  expect(out[0].contentType).toBe('text/markdown')
  expect(out[0].assetId).toBe('5c1e1e1e-1111-2222-3333-444455556666')
})

test('normalizeAttachments drops items without a url', () => {
  expect(normalizeAttachments([{ name: 'no-url.md' }])).toEqual([])
})

test('normalizeAttachments returns [] for non-array input', () => {
  expect(normalizeAttachments(undefined)).toEqual([])
  expect(normalizeAttachments(null)).toEqual([])
  expect(normalizeAttachments('not-an-array')).toEqual([])
})

test('renderAttachmentNotice uses the asset-text endpoint when assetId present', () => {
  const notice = renderAttachmentNotice([
    { url: 'https://x/y.md', name: 'y.md', contentType: 'text/markdown', size: null, assetId: 'abc-123' },
  ])
  expect(notice).toContain('GET /api/v2/assets/abc-123/text')
  expect(notice).toContain('y.md')
})

test('renderAttachmentNotice falls back to url when assetId absent', () => {
  const notice = renderAttachmentNotice([
    { url: 'https://x/y.md', name: 'y.md', contentType: 'text/markdown', size: null, assetId: '' },
  ])
  expect(notice).toContain('url: https://x/y.md')
  expect(notice).not.toContain('/text')
})

// ── Integration: real runSprintableSSE against a mock SSE server ─────────────
// parseEvent() is a private closure inside runSprintableSSE (not exported), so this is the
// only way to pin its actual wiring (content merge + drop-check widening), not just the
// standalone helpers above.

function startMockSseServer(dataLine: string) {
  return Bun.serve({
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
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    },
  })
}

async function receiveOne(dataLine: string): Promise<MessageContext> {
  const server = startMockSseServer(dataLine)
  const controller = new AbortController()
  const received = await new Promise<MessageContext>((resolve) => {
    runSprintableSSE({
      apiUrl: `http://localhost:${server.port}`,
      apiKey: 'test-key',
      signal: controller.signal,
      onMessage: async (ctx) => {
        controller.abort()
        resolve(ctx)
      },
    }).catch(() => {})
  })
  server.stop(true)
  return received
}

test('parseEvent populates attachments and merges notice into content', async () => {
  const ctx = await receiveOne(JSON.stringify({
    event_type: 'dispatched', event_id: 'evt-attach',
    content: '여기 파일 첨부했음', attachments: [ATTACHMENT],
  }))
  expect(ctx.attachments).toHaveLength(1)
  expect(ctx.attachments[0].name).toBe('notes.md')
  expect(ctx.content).toContain('여기 파일 첨부했음')
  expect(ctx.content).toContain('notes.md')
  expect(ctx.content).toContain('GET /api/v2/assets/5c1e1e1e-1111-2222-3333-444455556666/text')
})

test('parseEvent is not dropped when only an attachment is present, no text', async () => {
  const ctx = await receiveOne(JSON.stringify({
    event_type: 'dispatched', event_id: 'evt-attach-only',
    content: '', attachments: [ATTACHMENT],
  }))
  expect(ctx.content).toContain('notes.md')
})

test('parseEvent reads attachments from the payload fallback (real backend shape)', async () => {
  const ctx = await receiveOne(JSON.stringify({
    event_type: 'dispatched', event_id: 'evt-payload-attach',
    payload: { content: '본문', attachments: [ATTACHMENT] },
  }))
  expect(ctx.attachments).toHaveLength(1)
  expect(ctx.content).toContain('notes.md')
})

test('parseEvent still drops truly empty events (no content, no attachments)', async () => {
  const server = startMockSseServer(JSON.stringify({
    event_type: 'dispatched', event_id: 'evt-empty', content: '',
  }))
  const controller = new AbortController()
  let gotMessage = false
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 300))
  const run = runSprintableSSE({
    apiUrl: `http://localhost:${server.port}`,
    apiKey: 'test-key',
    signal: controller.signal,
    onMessage: async () => { gotMessage = true },
  }).catch(() => {})
  await timeout
  controller.abort()
  await run
  server.stop(true)
  expect(gotMessage).toBe(false)
})
