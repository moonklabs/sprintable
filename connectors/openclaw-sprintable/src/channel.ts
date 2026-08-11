/**
 * Sprintable channel plugin for OpenClaw — ChannelPlugin object.
 *
 * SSE dial-out pattern (matches every other Sprintable connector): outbound-only
 * consumption of GET /api/v2/agent/stream, no inbound webhook. `gateway.startAccount`
 * is OpenClaw's documented seam for exactly this ("Channel plugins that need... AI-powered
 * response generation and delivery", @since Plugin SDK 2026.2.19) — ground-truthed against
 * the real openclaw@2026.7.1-2 npm package's shipped .d.ts (not assumed from older code).
 *
 * `base` is built as a plain object (not via the `createChannelPluginBase(...)` helper) —
 * that helper's own option type does not accept a `gateway` field at all, while `base`'s
 * type (`Omit<ChannelPlugin, "security"|"pairing"|"threading"|"outbound"> & Partial<...>`)
 * does allow it since `gateway` is optional on the full `ChannelPlugin` type and isn't
 * excluded by that Omit. A plain object is simplest and fully type-correct here.
 */
import { createChatChannelPlugin } from 'openclaw/plugin-sdk/channel-core'
import type { ChannelPlugin, OpenClawConfig, PluginRuntime } from 'openclaw/plugin-sdk/channel-core'
import { DEFAULT_ACCOUNT_ID } from 'openclaw/plugin-sdk/account-id'
import { runSprintableSSE } from '../sprintable-sse.js'

export const CHANNEL_ID = 'sprintable'
const DEFAULT_API_URL = 'https://app.sprintable.ai'

type SprintableAccount = {
  accountId: string
  configured: boolean
  apiKey: string
  apiUrl: string
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): SprintableAccount {
  const section = (cfg.channels as Record<string, unknown>)?.[CHANNEL_ID] as
    | Record<string, unknown>
    | undefined
  // Dual resolution (config OR env), matching the doc's channelEnvVars pattern and this
  // connector family's existing convention (opencode/grok/gemini all read AGENT_API_KEY too).
  const apiKey = String(section?.apiKey ?? process.env.SPRINTABLE_API_KEY ?? process.env.AGENT_API_KEY ?? '')
  const apiUrl = String(section?.apiUrl ?? process.env.SPRINTABLE_API_URL ?? DEFAULT_API_URL)
  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    configured: Boolean(apiKey),
    apiKey,
    apiUrl,
  }
}

// One AbortController per running account — stopAccount() must be able to reach the
// exact controller startAccount() created, not rely on ctx.abortSignal alone (that
// signal already fires on gateway stop, but stopAccount is also OpenClaw's own explicit
// per-account teardown seam — wiring both keeps behavior correct under either trigger).
const runningControllers = new Map<string, AbortController>()

export const sprintablePlugin: ChannelPlugin<SprintableAccount> = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: 'Sprintable',
      selectionLabel: 'Sprintable Agent Gateway',
      docsPath: '/channels/sprintable',
      blurb: 'Sprintable project management — dial-out SSE gateway',
    },
    capabilities: {
      chatTypes: ['direct', 'group'],
      media: false,
      reply: true,
      threads: false,
    },
    config: {
      listAccountIds: (cfg) => {
        const section = (cfg.channels as Record<string, unknown>)?.[CHANNEL_ID]
        return section ? [DEFAULT_ACCOUNT_ID] : []
      },
      resolveAccount,
      inspectAccount(cfg, accountId) {
        const account = resolveAccount(cfg, accountId)
        return {
          enabled: account.configured,
          configured: account.configured,
          apiKeyStatus: account.configured ? 'available' : 'missing',
        }
      },
    },
    setup: {
      applyAccountConfig: ({ cfg, input }) => ({
        ...cfg,
        channels: {
          ...(cfg as Record<string, unknown>).channels,
          [CHANNEL_ID]: { ...((cfg as Record<string, unknown>).channels as any)?.[CHANNEL_ID], ...input },
        },
      }),
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    messaging: {
      targetPrefixes: [CHANNEL_ID],
      normalizeTarget: (target: string) => target.replace(/^sprintable:/, ''),
      targetResolver: {
        looksLikeId: (target: string) => target.startsWith('sprintable:') || target.includes('/'),
        hint: 'sprintable:<conversation_id>',
      },
      resolveOutboundSessionRoute: ({ to }: { to: string }) => ({
        agentId: DEFAULT_ACCOUNT_ID,
        sessionKey: to.replace(/^sprintable:/, ''),
      }),
    },
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account
        if (!account.configured) {
          ctx.log?.warn?.(`[sprintable] account ${account.accountId} not configured — skipping`)
          return
        }
        ctx.setStatus({ accountId: account.accountId, configured: true, enabled: true })
        ctx.log?.info?.(`[sprintable] starting SSE dial-out for account ${account.accountId}`)

        const rt = ctx.channelRuntime as unknown as PluginRuntime['channel'] | undefined
        if (!rt?.inbound) {
          ctx.log?.warn?.('[sprintable] channelRuntime.inbound unavailable — skipping turn dispatch')
          return
        }

        // Own controller, chained to ctx.abortSignal — either the gateway-level signal
        // firing OR an explicit stopAccount() call tears the SSE loop down (see #2578/S7
        // QA: dispose must actually abort the in-flight fetch, not just skip reconnects —
        // runSprintableSSE's own signal wiring already handles that correctly; this just
        // makes sure something actually calls abort() on both triggers).
        const controller = new AbortController()
        ctx.abortSignal.addEventListener('abort', () => controller.abort(), { once: true })
        runningControllers.set(account.accountId, controller)

        const agentsCfg = (ctx.cfg as Record<string, unknown>).agents as
          | { accounts?: Record<string, unknown> }
          | undefined
        const agentId = Object.keys(agentsCfg?.accounts ?? {})[0] ?? DEFAULT_ACCOUNT_ID

        await runSprintableSSE({
          apiUrl: account.apiUrl,
          apiKey: account.apiKey,
          signal: controller.signal,
          onMessage: async (msg) => {
            const ctxPayload = rt.inbound.buildContext({
              channel: CHANNEL_ID,
              accountId: account.accountId,
              messageId: msg.eventId,
              timestamp: new Date(),
              from: `sprintable:${msg.conversationId || msg.senderId}`,
              sender: { id: msg.senderId, name: msg.senderName },
              conversation: { kind: 'group', id: msg.conversationId, label: msg.conversationId },
              route: { agentId, accountId: account.accountId, routeSessionKey: msg.conversationId },
              reply: { to: `sprintable:${msg.conversationId}` },
              message: {
                body: msg.content,
                bodyForAgent: msg.content,
                rawBody: msg.content,
                commandBody: msg.content,
              },
            })

            await rt.inbound.dispatchReply({
              channel: CHANNEL_ID,
              accountId: account.accountId,
              cfg: ctx.cfg,
              agentId,
              routeSessionKey: msg.conversationId,
              storePath: undefined,
              ctxPayload,
              recordInboundSession: rt.session?.recordInboundSession,
              dispatchReplyWithBufferedBlockDispatcher: rt.reply?.dispatchReplyWithBufferedBlockDispatcher,
              delivery: {
                durable: () => ({ to: `sprintable:${msg.conversationId}` }),
                deliver: async (payload: { text?: string }) => {
                  if (payload.text) await msg.reply(payload.text)
                },
              },
            })
          },
        })
      },
      stopAccount: async (ctx) => {
        const controller = runningControllers.get(ctx.account.accountId)
        controller?.abort()
        runningControllers.delete(ctx.account.accountId)
        ctx.log?.info?.(`[sprintable] stopped SSE dial-out for account ${ctx.account.accountId}`)
      },
    },
  },
  outbound: {
    deliveryMode: 'direct',
    textChunkLimit: 4000,
    resolveTarget: ({ to }: { to: string }) => ({ ok: true, target: to.replace(/^sprintable:/, '') }),
    deliveryCapabilities: { durableFinal: { text: true } },
  },
})
