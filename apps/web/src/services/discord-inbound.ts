import type { BridgeInboundEvent } from './bridge-inbound';
import { resolveDiscordToken } from './discord-bridge-utils';

export interface DiscordMessageAuthor {
  id: string;
  username?: string;
  bot?: boolean;
}

export interface DiscordMessageEvent {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  author?: DiscordMessageAuthor;
  webhook_id?: string;
  thread?: { id?: string; parent_id?: string };
  message_reference?: { message_id?: string; channel_id?: string; guild_id?: string };
}

export interface DiscordGatewayPayload<T = unknown> {
  op: number;
  d: T;
  s?: number | null;
  t?: string | null;
}

export interface DiscordBridgeConfig {
  requireMention: boolean;
  botUserId: string | null;
}

export const DISCORD_RATE_LIMIT_NOTICE = '이 채널은 분당 60건 제한으로 잠시 일부 Discord 메시지를 처리하지 않는.';
export const DISCORD_MAX_MESSAGE_LENGTH = 2000;

export function resolveDiscordBridgeConfig(config: Record<string, string> | null | undefined, env: NodeJS.ProcessEnv = process.env): DiscordBridgeConfig {
  const requireMentionValue = resolveDiscordToken(config?.require_mention, env) ?? config?.require_mention ?? null;
  return {
    requireMention: requireMentionValue === 'true',
    botUserId: resolveDiscordToken(config?.bot_user_id, env),
  };
}

function stripBotMention(text: string, botUserId: string | null) {
  if (!botUserId) return text.trim();
  return text.replaceAll(`<@${botUserId}>`, ' ').replaceAll(`<@!${botUserId}>`, ' ').replace(/\s+/g, ' ').trim();
}

export function shouldIgnoreDiscordMessage(event: DiscordMessageEvent, config: DiscordBridgeConfig): boolean {
  if (!event.channel_id || !event.author?.id) return true;
  if (event.webhook_id || event.author.bot) return true;
  if (!config.requireMention) return false;
  if (!config.botUserId) return true;
  const text = event.content ?? '';
  return !(text.includes(`<@${config.botUserId}>`) || text.includes(`<@!${config.botUserId}>`));
}

export function getDiscordSourceChannelId(event: DiscordMessageEvent) {
  return event.thread?.parent_id ?? event.channel_id;
}

export function getDiscordThreadId(event: DiscordMessageEvent) {
  if (event.thread?.id) return event.thread.id;
  if (event.thread?.parent_id && event.channel_id !== event.thread.parent_id) return event.channel_id;
  return null;
}

export function normalizeDiscordEvent(
  event: DiscordMessageEvent,
  config: DiscordBridgeConfig,
): BridgeInboundEvent {
  return {
    channelId: getDiscordSourceChannelId(event),
    userId: event.author?.id ?? null,
    eventId: event.id,
    messageText: stripBotMention(event.content ?? '', config.botUserId),
    messageTs: event.id,
    threadTs: getDiscordThreadId(event),
    teamId: event.guild_id ?? null,
    raw: event,
  };
}

export async function postDiscordRateLimitNotice(
  token: string,
  params: { channelId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetchImpl(`https://discord.com/api/v10/channels/${params.channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      content: DISCORD_RATE_LIMIT_NOTICE,
      allowed_mentions: { parse: [] },
    }),
  });

  return response.ok;
}
