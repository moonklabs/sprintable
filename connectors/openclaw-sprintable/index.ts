/**
 * Sprintable Gateway adapter for OpenClaw — E-INJECT-ADAPTERS (카테고리 A).
 *
 * SSE dial-out 패턴: /api/v2/agent/stream 소비 → inbound turn 주입 → 응답 → ack.
 * 공통 SDK(connectors/sdk/sprintable-sse.ts) 재사용.
 * Tlon 채널 어댑터(extensions/tlon/)와 동형 구조.
 */

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { PluginRuntime } from "openclaw/plugin-sdk";
import { runSprintableSSE } from "../sdk/sprintable-sse.js";

const CHANNEL_ID = "sprintable" as const;
const DEFAULT_API_URL = "https://sprintable-backend-dev-57iommnikq-du.a.run.app";

// ── Account shape ─────────────────────────────────────────────────────────────

type SprintableAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  apiKey: string;
  apiUrl: string;
};

function resolveAccount(cfg: Record<string, unknown>, accountId?: string): SprintableAccount {
  const section = (cfg.channels as Record<string, unknown>)?.[CHANNEL_ID] as Record<string, unknown> | undefined;
  const id = accountId ?? DEFAULT_ACCOUNT_ID;
  return {
    accountId: id,
    enabled: section?.enabled !== false,
    configured: Boolean(section?.apiKey ?? process.env.AGENT_API_KEY),
    apiKey: String(section?.apiKey ?? process.env.AGENT_API_KEY ?? ""),
    apiUrl: String(section?.apiUrl ?? process.env.SPRINTABLE_API_URL ?? DEFAULT_API_URL),
  };
}

// ── Sprintable channel plugin ─────────────────────────────────────────────────

export const sprintablePlugin: ChannelPlugin<SprintableAccount> = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "Sprintable",
      selectionLabel: "Sprintable Agent Gateway",
      docsPath: "/channels/sprintable",
      docsLabel: "sprintable",
      blurb: "Sprintable project management — dial-out SSE gateway",
      aliases: ["sprintable"],
      order: 95,
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      media: false,
      reply: true,
      threads: false,
    },
    setup: {
      isConfigured: (account: SprintableAccount) => account.configured,
      describeAccount: (account: SprintableAccount) => ({
        accountId: account.accountId,
        configured: account.configured,
        enabled: account.enabled,
      }),
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    config: {
      listAccountIds: (cfg) => {
        const section = (cfg.channels as Record<string, unknown>)?.[CHANNEL_ID];
        return section ? [DEFAULT_ACCOUNT_ID] : [];
      },
      resolveAccount: (cfg, accountId) => resolveAccount(cfg as Record<string, unknown>, accountId),
      isConfigured: (account: SprintableAccount) => account.configured,
      describeAccount: (account: SprintableAccount) => ({
        accountId: account.accountId,
        configured: account.configured,
        enabled: account.enabled,
      }),
    },
    messaging: {
      targetPrefixes: [CHANNEL_ID],
      normalizeTarget: (target: string) => target.replace(/^sprintable:/, ""),
      targetResolver: {
        looksLikeId: (target: string) => target.startsWith("sprintable:") || target.includes("/"),
        hint: "sprintable:<conversation_id>",
      },
      resolveOutboundSessionRoute: ({ to }: { to: string }) => ({
        agentId: DEFAULT_ACCOUNT_ID,
        sessionKey: to.replace(/^sprintable:/, ""),
      }),
    },
    gateway: {
      startAccount: async (ctx) => {
        const account = ctx.account;
        if (!account.configured || !account.apiKey) {
          ctx.log?.warn?.(`[sprintable] account ${account.accountId} not configured — skipping`);
          return;
        }
        ctx.setStatus({
          accountId: account.accountId,
          configured: true,
          enabled: account.enabled,
        });
        ctx.log?.info?.(`[sprintable] starting gateway dial-out for account ${account.accountId}`);

        // channelRuntime 접근 (optional —외부 플러그인 호환)
        const rt = ctx.channelRuntime as unknown as PluginRuntime["channel"] | undefined;
        if (!rt?.inbound) {
          ctx.log?.warn?.("[sprintable] channelRuntime.inbound unavailable — skipping turn dispatch");
          return;
        }

        // 기본 agentId: cfg.agents.accounts의 첫 번째 에이전트 또는 "main"
        const agentsCfg = (ctx.cfg as Record<string, unknown>).agents as
          | { accounts?: Record<string, unknown> } | undefined;
        const agentId =
          Object.keys(agentsCfg?.accounts ?? {})[0] ?? DEFAULT_ACCOUNT_ID;

        await runSprintableSSE({
          apiUrl: account.apiUrl,
          apiKey: account.apiKey,
          signal: ctx.abortSignal,
          onMessage: async (msg) => {
            const ctxPayload = rt.inbound.buildContext({
              channel: CHANNEL_ID,
              accountId: account.accountId,
              messageId: msg.eventId,
              timestamp: new Date(),
              from: `sprintable:${msg.conversationId || msg.senderId}`,
              sender: {
                id: msg.senderId,
                name: msg.senderName,
              },
              conversation: {
                kind: "group",
                id: msg.conversationId,
                label: msg.conversationId,
              },
              route: {
                agentId,
                accountId: account.accountId,
                routeSessionKey: msg.conversationId,
              },
              reply: {
                to: `sprintable:${msg.conversationId}`,
              },
              message: {
                body: msg.content,
                bodyForAgent: msg.content,
                rawBody: msg.content,
                commandBody: msg.content,
              },
            });

            await rt.inbound.dispatchReply({
              channel: CHANNEL_ID,
              accountId: account.accountId,
              cfg: ctx.cfg,
              agentId,
              routeSessionKey: msg.conversationId,
              storePath: undefined,
              ctxPayload,
              recordInboundSession: rt.session?.recordInboundSession,
              dispatchReplyWithBufferedBlockDispatcher:
                rt.reply?.dispatchReplyWithBufferedBlockDispatcher,
              delivery: {
                durable: () => ({ to: `sprintable:${msg.conversationId}` }),
                deliver: async (payload: { text?: string }) => {
                  if (payload.text) await msg.reply(payload.text);
                },
              },
            });
          },
        });
      },
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    resolveTarget: ({ to }: { to: string }) => ({
      ok: true,
      target: to.replace(/^sprintable:/, ""),
    }),
    deliveryCapabilities: {
      durableFinal: { text: true },
    },
  },
});
