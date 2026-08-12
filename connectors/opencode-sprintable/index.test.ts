// story #2583 — regression pin: opencode-sprintable's session.prompt() must carry the
// standard envelope (sender/event_kind/ts), not bare msg.content. Before this fix, the
// SDK parsed sender correctly but this connector's injection call dropped it — the same
// assembly-stage defect class as pi-sprintable's #2574/#2583 fix (index.test.ts there).
// Real mock SSE server (real sockets/HTTP, no real Sprintable backend) + a fake OpenCode
// client (no real opencode binary) — same boundary methodology as the pi connector's test.
import { test, expect } from "bun:test"
import { plugin } from "./index.js"

function startMockSseServer(dataLines: string[]) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      if (req.url.includes("/api/v2/agent/stream")) {
        const stream = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder()
            dataLines.forEach((dataLine, i) => {
              controller.enqueue(enc.encode(`event: message\nid: ${i + 1}\ndata: ${dataLine}\n\n`))
            })
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
  const server = startMockSseServer([JSON.stringify({
    event_type: "dispatched", event_id: "evt-1",
    content: "hello from sprintable",
    payload: { conversation_id: "conv-test-1", sender: { id: "s1", name: "tester" } },
  })])
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

test("story #2583 S3 — misaddressing blocked end-to-end: sender switch across two real SSE deliveries never leaks", async () => {
  // Reproduces the Dan Irwin incident shape through the ACTUAL connector pipeline (real mock
  // SSE server -> onMessage -> session.prompt), not just the pure formatEnvelopeText()
  // function in isolation (already pinned in envelope-format.test.ts) — this is what "e2e"
  // means for S3: prove the value the whole S2 body of work exists to deliver.
  const server = startMockSseServer([
    JSON.stringify({
      event_type: "dispatched", event_id: "evt-a",
      content: "통신점검", recipient_seq: 1,
      payload: { conversation_id: "conv-shared", sender: { id: "p1", name: "페드루 올리베이라", type: "agent" } },
    }),
    JSON.stringify({
      event_type: "dispatched", event_id: "evt-b",
      content: "이거 다시 봐줘", recipient_seq: 2,
      payload: { conversation_id: "conv-shared", sender: { id: "u1", name: "송윤재", type: "human" } },
    }),
  ])
  process.env.SPRINTABLE_API_KEY = "test-key"
  process.env.SPRINTABLE_API_URL = `http://localhost:${server.port}`

  const client = makeFakeClient()
  await plugin({ client } as never)

  await new Promise((resolve) => setTimeout(resolve, 400))

  expect(client.promptCalls).toHaveLength(2)
  const first = client.promptCalls[0].body.parts[0].text
  const second = client.promptCalls[1].body.parts[0].text

  expect(first).toContain("페드루 올리베이라")
  expect(first).toContain("(agent)")
  expect(second).toContain("송윤재")
  expect(second).toContain("(human)")
  // 핵심 단정 — 두 번째 전달(사람이 보낸 메시지)의 렌더 텍스트에 «직전 발신자»(페드루)
  // 이름이 조금이라도 새어 들어가면 오호칭 사고가 재현된 것.
  expect(second).not.toContain("페드루")

  server.stop(true)
})
