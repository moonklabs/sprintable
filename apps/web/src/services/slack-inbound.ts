import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BridgeInboundEvent } from './bridge-inbound';

export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
}

export interface SlackEventEnvelope {
  type: string;
  event?: SlackMessageEvent;
  team_id?: string;
  challenge?: string;
  event_id?: string;
}

export interface SlackBridgeConfig {
  requireMention: boolean;
  botUserId: string | null;
  botToken: string | null;
}

export const SLACK_RATE_LIMIT_NOTICE = '이 채널은 분당 60건 제한으로 잠시 일부 Slack 메시지를 처리하지 않는.';

export function verifySlackSignature(
  signingSecret: string,
  signature: string | null,
  timestamp: string | null,
  rawBody: string,
): boolean {
  if (!signature || !timestamp) return false;

  const ts = Number(timestamp);
  if (Number.isNaN(ts)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) return false;

  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  if (expected.length !== signature.length) return false;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function resolveSecret(ref: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ref) return null;
  if (ref.startsWith('env:')) return env[ref.slice(4)] ?? null;
  if (ref.startsWith('vault:')) return null;
  return ref;
}

export function resolveSlackBridgeConfig(config: Record<string, string> | null | undefined, env: NodeJS.ProcessEnv = process.env): SlackBridgeConfig {
  const requireMentionValue = resolveSecret(config?.require_mention, env) ?? config?.require_mention ?? null;

  return {
    requireMention: requireMentionValue === 'true',
    botUserId: resolveSecret(config?.bot_user_id, env),
    botToken: resolveSecret(config?.bot_token, env),
  };
}

function stripBotMention(text: string, botUserId: string | null) {
  if (!botUserId) return text.trim();
  return text.replaceAll(`<@${botUserId}>`, ' ').replace(/\s+/g, ' ').trim();
}

export function shouldIgnoreSlackMessage(event: SlackMessageEvent, config: SlackBridgeConfig): boolean {
  if (event.type !== 'message' || event.subtype || event.bot_id) return true;
  if (!event.channel || !event.user) return true;
  if (!config.requireMention) return false;
  if (!config.botUserId) return true;
  return !(event.text ?? '').includes(`<@${config.botUserId}>`);
}

export function normalizeSlackEvent(
  event: SlackMessageEvent,
  teamId: string,
  config: SlackBridgeConfig,
  eventId: string | null = null,
): BridgeInboundEvent {
  return {
    channelId: event.channel,
    userId: event.user ?? null,
    eventId,
    messageText: stripBotMention(event.text ?? '', config.botUserId),
    messageTs: event.ts ?? null,
    threadTs: event.thread_ts ?? null,
    teamId,
    raw: event,
  };
}

export async function postSlackRateLimitNotice(
  token: string,
  params: { channel: string; threadTs?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const response = await fetchImpl('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: params.channel,
      text: SLACK_RATE_LIMIT_NOTICE,
      thread_ts: params.threadTs ?? undefined,
    }),
  });

  if (!response.ok) return false;

  const body = await response.json() as { ok?: boolean };
  return body.ok === true;
}
