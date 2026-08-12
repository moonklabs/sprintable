/**
 * Sprintable Gateway extension for Pi — in-process ExtensionAPI (E-AGENT-ONBOARD S7b, #2574).
 *
 * Category A (in-process), NOT a rewrite of the sibling host.py, which is Category B
 * (host spawns/owns pi as a child process) — the opposite shape from what Pi's own
 * extension system requires. host.py is kept as-is, a preserved alternative (same
 * "keep the old pattern around" call as the codex plugin's own host.py precedent) —
 * this file is the real, publishable `sprintable-pi` npm package entry.
 *
 * Ground-truthed against the real `@earendil-works/pi-coding-agent`@0.84.1 npm
 * package's shipped .d.ts (not assumed from the story description alone — that
 * description's own `sendUserMessage(steer, triggerTurn)` phrasing turned out to be
 * slightly imprecise: `sendUserMessage` only takes `deliverAs`, not `triggerTurn`
 * — its doc comment says "Always triggers a turn", so no separate flag is needed;
 * `triggerTurn` is a `sendMessage` option instead, for the *custom*-message API this
 * extension doesn't use).
 *
 * Pi is architecturally simpler here than every other Sprintable connector: it's
 * in-process (the extension factory runs inside the same process as the running
 * session), so there's no separate-CLI-invocation idle-wake problem to solve at all
 * (unlike codex/grok/gemini, which all spawn a fresh `<cli> -r <session> -p <msg>`
 * process to wake an idle session). `sendUserMessage(..., {deliverAs: "steer"})`
 * injects correctly whether the agent is idle or mid-turn — the SDK's own doc
 * comment: "When the agent is streaming, use deliverAs to specify how to queue the
 * message."
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { runSprintableSSE, formatEnvelopeText, type MessageContext } from './sprintable-sse.js'

/**
 * Pi's extension factory. Per the SDK's own documented discipline (and this
 * story's own trap list, #2574 AC3): do NOT start background resources — sockets,
 * listeners, timers — directly in the factory body. Only register `pi.on(...)`
 * handlers here; the actual SSE connection opens inside the `session_start`
 * handler, which is the correct lifecycle hook for it.
 *
 * Credentials are resolved fresh on each factory call, not cached as module-level
 * constants — a module-level `const API_KEY = process.env...` would freeze at
 * first import (whenever that happens to occur) rather than reflecting the
 * environment at actual extension-load time. Matches the per-call resolution
 * pattern the other connectors already use (e.g. openclaw-sprintable's
 * `resolveAccount`), and is what makes this factory unit-testable at all.
 */
export default function sprintableExtension(pi: ExtensionAPI): void {
  const API_URL = (process.env.SPRINTABLE_API_URL ?? 'https://app.sprintable.ai').replace(/\/$/, '')
  const API_KEY = (process.env.SPRINTABLE_API_KEY ?? process.env.AGENT_API_KEY ?? '').trim()
  if (!API_KEY) {
    // AC3: credentials unset -> completely silent no-op, no handlers registered
    // that would do anything observable. Matches every sibling connector's
    // "safe until configured" contract.
    return
  }

  const controller = new AbortController()
  // Single-session extension (in-process, one Pi session per process) — this
  // extension only ever talks to whichever Sprintable conversation most recently
  // sent it a message, mirroring the "most recent context wins" pattern the other
  // connectors already use for their own single-active-conversation tracking.
  let lastCtx: MessageContext | null = null

  pi.on('session_start', () => {
    runSprintableSSE({
      apiUrl: API_URL,
      apiKey: API_KEY,
      signal: controller.signal,
      onMessage: async (ctx) => {
        lastCtx = ctx
        // story #2583 — 발신자/이벤트종류/ts를 조립 단계에서 버리지 않고 표준 envelope로
        // 렌더(ctx.content만 보내면 모델이 발신자를 모른 채 진행 — 댄 어윈 오호칭 사고 클래스).
        pi.sendUserMessage(formatEnvelopeText(ctx), { deliverAs: 'steer' })
      },
    }).catch((err) => {
      if (!controller.signal.aborted) {
        process.stderr.write(`[sprintable] SSE fatal error: ${err}\n`)
      }
    })
  })

  pi.on('session_shutdown', () => {
    controller.abort()
  })

  // Auto-reply, same pattern as every other Sprintable connector (gemini's
  // AfterAgent, codex's Stop hook): post the agent's own response back to
  // Sprintable without requiring the agent to remember to call a tool.
  pi.on('agent_end', (event) => {
    if (!lastCtx) return
    const assistantMessages = event.messages.filter(
      (m): m is Extract<typeof m, { role: 'assistant' }> => m.role === 'assistant',
    )
    const last = assistantMessages[assistantMessages.length - 1]
    if (!last) return
    const text = last.content
      .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .trim()
    if (!text) return
    void lastCtx.reply(text).catch((err) => {
      process.stderr.write(`[sprintable] reply failed: ${err}\n`)
    })
  })
}
