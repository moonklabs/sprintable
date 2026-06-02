/**
 * Sprintable Gateway adapter for OpenCode — E-INJECT-ADAPTERS (카테고리 A).
 *
 * SSE dial-out 패턴: /api/v2/agent/stream 소비 → opencode session.prompt → 응답 → ack.
 * 공통 SDK(connectors/sdk/sprintable-sse.ts) 재사용.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { runSprintableSSE } from "../sdk/sprintable-sse.js"

const API_URL = (process.env.SPRINTABLE_API_URL ?? "https://sprintable-backend-dev-57iommnikq-du.a.run.app").replace(/\/$/, "")
const API_KEY = (process.env.SPRINTABLE_API_KEY ?? process.env.AGENT_API_KEY ?? "").trim()

/**
 * Sprintable Gateway OpenCode plugin.
 *
 * Lifecycle:
 * 1. Plugin 초기화 시 background SSE stream 시작 (fire-and-forget, AbortController로 shutdown)
 * 2. 이벤트마다 opencode session 생성/재사용 → session.prompt() 로 turn 주입
 * 3. session.prompt 응답 → POST /api/v2/conversations/{id}/messages (ack는 SDK 처리)
 */
export const plugin: Plugin = async ({ client }) => {
  if (!API_KEY) {
    console.error("[sprintable] SPRINTABLE_API_KEY or AGENT_API_KEY not set — plugin disabled")
    return {}
  }

  const controller = new AbortController()

  // conversation_id → opencode session_id 매핑 (재사용)
  const sessionMap = new Map<string, string>()

  // Fire-and-forget background SSE stream — plugin 수명과 함께
  runSprintableSSE({
    apiUrl: API_URL,
    apiKey: API_KEY,
    signal: controller.signal,
    onMessage: async (msg) => {
      const conversationId = msg.conversationId
      if (!conversationId) return

      // opencode session 재사용 또는 신규 생성
      let sessionId = sessionMap.get(conversationId)
      if (!sessionId) {
        const createResp = await client.session.create({
          body: {},
        })
        const newId = (createResp as { data?: { id?: string } }).data?.id
        if (!newId) {
          console.error(`[sprintable] failed to create session for conv=${conversationId}`)
          return
        }
        sessionId = newId
        sessionMap.set(conversationId, sessionId)
      }

      // Turn 주입 — session.prompt는 AI 응답 완성까지 대기
      let responseText = ""
      try {
        const promptResp = await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{ type: "text", text: msg.content }],
          },
        })
        // 응답에서 텍스트 추출
        const respData = promptResp as { data?: { parts?: Array<{ type: string; text?: string }> } }
        responseText = (respData.data?.parts ?? [])
          .filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("")
          .trim()
      } catch (err) {
        console.error(`[sprintable] session.prompt error session=${sessionId}: ${err}`)
        return
      }

      // 응답 → Sprintable Conversations API
      if (responseText) {
        await msg.reply(responseText)
      }
    },
  }).catch((err) => {
    if (!controller.signal.aborted) {
      console.error(`[sprintable] SSE fatal error: ${err}`)
    }
  })

  return {
    // plugin 종료 시 SSE stream 정리
    // (opencode plugin lifecycle에 shutdown hook이 없으므로 process 종료 시 자동 정리)
  }
}

export default plugin
