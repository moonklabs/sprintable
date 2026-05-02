import type { SupabaseClient, RealtimeChannelLike } from '@/types/supabase';
import { MemoService } from './memo';
import { buildAbsoluteMemoLink } from './app-url';

interface ReplyRow {
  id: string;
  memo_id: string;
  content: string;
  created_by: string;
  created_at: string;
}

interface MemoRow {
  id: string;
  org_id: string;
  project_id: string;
  metadata: Record<string, unknown> | null;
}

interface ChannelMappingRow {
  channel_id: string;
  config: Record<string, string> | null;
}

interface TeamMemberRow {
  id: string;
}

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

export interface SlackOutboundDispatcherOptions {
  db: SupabaseClient;
  logger?: Logger;
  fetchFn?: typeof fetch;
  appUrl?: string;
  retryDelayMs?: number;
  maxRetries?: number;
}

export interface SlackDispatchResult {
  status: 'sent' | 'skipped' | 'failed';
  reason?: string;
  attempts?: number;
}

const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRIES = 3;
const FAILURE_COMMENT_PREFIX = 'Slack 전송 실패';
const MAX_SLACK_TEXT_LENGTH = 3000;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSlackSourceMemo(metadata: unknown): metadata is Record<string, unknown> {
  return isObject(metadata) && metadata.source === 'slack' && typeof metadata.channel_id === 'string';
}

export function isFailureComment(content: string) {
  return content.trim().startsWith(FAILURE_COMMENT_PREFIX);
}

export function resolveSecretRef(ref: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!ref) return null;
  if (ref.startsWith('env:')) return env[ref.slice(4)] ?? null;
  if (ref.startsWith('vault:')) return null;
  return ref;
}

export function buildSlackMemoLink(appUrl: string | undefined, memoId: string): string {
  return buildAbsoluteMemoLink(memoId, appUrl);
}

export function buildSlackOutboundText(content: string, memoLink: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_SLACK_TEXT_LENGTH) {
    return trimmed;
  }

  const suffix = `\n\n전체 내용은 Sprintable에서 확인하세요 ${memoLink}`;
  const available = Math.max(0, MAX_SLACK_TEXT_LENGTH - suffix.length - 1);
  const truncated = trimmed.slice(0, available).trimEnd();
  return `${truncated}…${suffix}`;
}

export async function postSlackMessage(
  token: string,
  params: { channel: string; text: string; threadTs?: string | null },
  fetchFn: typeof fetch = fetch,
) {
  const response = await fetchFn('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: params.channel,
      text: params.text,
      thread_ts: params.threadTs ?? undefined,
    }),
  });

  let body: { ok?: boolean; error?: string } = {};
  try {
    body = await response.json() as { ok?: boolean; error?: string };
  } catch {
    body = {};
  }

  return {
    ok: response.ok && body.ok === true,
    status: response.status,
    error: body.error ?? (!response.ok ? `http_${response.status}` : 'slack_api_error'),
  };
}

export class SlackOutboundDispatcher {
  private readonly logger: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly appUrl: string | undefined;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly inFlightReplyIds = new Set<string>();
  private channel: RealtimeChannelLike | null = null;

  constructor(private readonly options: SlackOutboundDispatcherOptions) {
    this.logger = options.logger ?? console;
    this.fetchFn = options.fetchFn ?? fetch;
    this.appUrl = options.appUrl;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  start() {
    if (this.channel) return;

    this.channel = this.options.db
      .channel(`slack-outbound-dispatcher-${Date.now()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'memo_replies' }, (payload) => {
        const reply = payload.new as ReplyRow;
        void this.dispatchReplyIfNeeded(reply);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          this.logger.info('[SlackOutboundDispatcher] Realtime subscribed');
          return;
        }

        if (status === 'CHANNEL_ERROR' || status === 'CLOSED' || status === 'TIMED_OUT') {
          this.logger.warn(`[SlackOutboundDispatcher] Realtime channel status: ${status}`);
        }
      });
  }

  async stop() {
    if (!this.channel) return;
    await this.options.db.removeChannel(this.channel);
    this.channel = null;
  }

  async dispatchReplyIfNeeded(reply: ReplyRow): Promise<SlackDispatchResult> {
    if (this.inFlightReplyIds.has(reply.id)) {
      return { status: 'skipped', reason: 'reply_already_in_flight' };
    }

    if (isFailureComment(reply.content)) {
      return { status: 'skipped', reason: 'failure_comment' };
    }

    this.inFlightReplyIds.add(reply.id);
    try {
      const memo = await this.getMemo(reply.memo_id);
      if (!memo || !isSlackSourceMemo(memo.metadata)) {
        return { status: 'skipped', reason: 'memo_not_slack_source' };
      }

      const isAgentReply = await this.isActiveAgentReply(memo.org_id, memo.project_id, reply.created_by);
      if (!isAgentReply) {
        return { status: 'skipped', reason: 'reply_not_from_active_agent' };
      }

      const channelMapping = await this.getSlackChannelMapping(memo.org_id, memo.project_id, String(memo.metadata.channel_id));
      if (!channelMapping) {
        await this.recordFailure(reply, 'slack_channel_mapping_missing');
        return { status: 'failed', reason: 'slack_channel_mapping_missing', attempts: 0 };
      }

      const token = resolveSecretRef(channelMapping.config?.bot_token);
      if (!token) {
        await this.recordFailure(reply, 'slack_bot_token_missing');
        return { status: 'failed', reason: 'slack_bot_token_missing', attempts: 0 };
      }

      const memoLink = buildSlackMemoLink(this.appUrl, memo.id);
      const text = buildSlackOutboundText(reply.content, memoLink);
      const threadTs = typeof memo.metadata.thread_ts === 'string' ? memo.metadata.thread_ts : null;

      let lastError = 'unknown_error';
      for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
        try {
          const result = await postSlackMessage(token, {
            channel: String(memo.metadata.channel_id),
            text,
            threadTs,
          }, this.fetchFn);

          if (result.ok) {
            return { status: 'sent', attempts: attempt };
          }

          lastError = result.error;
          this.logger.warn(`[SlackOutboundDispatcher] Slack send failed (attempt ${attempt}/${this.maxRetries}): ${result.error}`);
        } catch (error) {
          lastError = error instanceof Error ? error.message : 'network_error';
          this.logger.warn(`[SlackOutboundDispatcher] Slack send exception (attempt ${attempt}/${this.maxRetries}): ${lastError}`);
        }

        if (attempt < this.maxRetries) {
          await wait(this.retryDelayMs);
        }
      }

      await this.recordFailure(reply, lastError);
      return { status: 'failed', reason: lastError, attempts: this.maxRetries };
    } finally {
      this.inFlightReplyIds.delete(reply.id);
    }
  }

  private async getMemo(memoId: string): Promise<MemoRow | null> {
    const { data } = await this.options.db
      .from('memos')
      .select('id, org_id, project_id, metadata')
      .eq('id', memoId)
      .maybeSingle();

    return (data as MemoRow | null) ?? null;
  }

  private async getSlackChannelMapping(orgId: string, projectId: string, channelId: string): Promise<ChannelMappingRow | null> {
    const { data } = await this.options.db
      .from('messaging_bridge_channels')
      .select('channel_id, config')
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('platform', 'slack')
      .eq('channel_id', channelId)
      .eq('is_active', true)
      .maybeSingle();

    return (data as ChannelMappingRow | null) ?? null;
  }

  private async isActiveAgentReply(orgId: string, projectId: string, createdBy: string): Promise<boolean> {
    const { data } = await this.options.db
      .from('team_members')
      .select('id')
      .eq('id', createdBy)
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('type', 'agent')
      .eq('is_active', true)
      .maybeSingle();

    return Boolean((data as TeamMemberRow | null)?.id);
  }

  private async recordFailure(reply: ReplyRow, reason: string) {
    this.logger.error('[SlackOutboundDispatcher] Slack 전송 실패', {
      memo_id: reply.memo_id,
      reply_id: reply.id,
      reason,
    });

    const memoService = MemoService.fromDb(this.options.db);
    await memoService.addReply(
      reply.memo_id,
      `${FAILURE_COMMENT_PREFIX}\n- reply_id: ${reply.id}\n- reason: ${reason}`,
      reply.created_by,
    );
  }
}
