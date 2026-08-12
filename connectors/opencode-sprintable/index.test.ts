// story #2583 — regression pin: opencode-sprintable's session.prompt() must carry the
// standard envelope (sender/event_kind/ts), not bare msg.content. Before this fix, the
// SDK parsed sender correctly but this connector's injection call dropped it — the same
// assembly-stage defect class as pi-sprintable's #2574/#2583 fix (index.test.ts there).
// Real mock SSE server (real sockets/HTTP, no real Sprintable backend) + a fake OpenCode
// client (no real opencode binary) — same boundary methodology as the pi connector's test.
import { test, expect } from "bun:test"
import { plugin } from "./index.js"

function startMockSseServer(dataLine: string) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      if (req.url.includes("/api/v2/agent/stream")) {
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            controller.enqueue(enc.encode(`event: message\nid: 1\ndata: ${dataLine}\n\n`))
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }
      if (req.url.includes("/messages") && req.method === "POST") {
        return new Response("{}", { status: 200 })
      }
      return new Response("{}", { headers: { "content-type": "application/json" } })
    },
  })
}

function makeFakeClient() {
  const promptCalls: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }[] = []
  return {
    promptCalls,
    session: {
      async create() {
        return { data: { id: "session-1" } }
      },
      async prompt(args: { path: { id: string }; body: { parts: Array<{ type: string; text: string }> } }) {
        promptCalls.push(args)
        return { data: { parts: [{ type: "text", text: "MOCKED_REPLY" }] } }
      },
    },
  }
}

test("inbound SSE message injects via session.prompt(formatEnvelopeText(msg))", async () => {
  const server = startMockSseServer(JSON.stringify({
    event_type: "dispatched", event_id: "evt-1",
    content: "hello from sprintable",
    payload: { conversation_id: "conv-test-1", sender: { id: "s1", name: "tester" } },
  }))
  process.env.SPRINTABLE_API_KEY = "test-key"
  process.env.SPRINTABLE_API_URL = `http://localhost:${server.port}`

  const client = makeFakeClient()
  await plugin({ client } as never)

  // give the SSE connection + onMessage callback a moment to actually run
  await new Promise((resolve) => setTimeout(resolve, 300))

  expect(client.promptCalls).toHaveLength(1)
  const text = client.promptCalls[0].body.parts[0].text
  // story #2583 — sender ("tester") must reach the model, not just the bare content.
  expect(text).toBe(
    "[dispatched] tester (unknown) · conv=conv-test-1 · ts=unknown\nhello from sprintable",
  )

  server.stop(true)
})
