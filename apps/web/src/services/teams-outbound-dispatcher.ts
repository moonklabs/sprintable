import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { MemoService } from './memo';
import { buildAbsoluteMemoLink } from './app-url';
import {
  fetchTeamsAppAccessToken,
  getActiveTeamsOrgAuth,
  isTeamsAuthExpired,
  notifyTeamsAuthFailed,
  resolveTeamsAppSecret,
  resolveTeamsBridgeConfig,
} from './teams-bridge-utils';

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

interface ReplyDispatchRow {
  id: string;
  status: 'pending' | 'sent' | 'failed';
  attempt_count: number;
  claim_token: string | null;
  claimed_at: string | null;
  sent_at: string | null;
  error_message: string | null;
  updated_at: string;
}

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

export interface TeamsOutboundDispatcherOptions {
  supabase: SupabaseClient;
  logger?: Logger;
  fetchFn?: typeof fetch;
  appUrl?: string;
  retryDelayMs?: number;
  maxRetries?: number;
  pollingIntervalMs?: number;
  pollBatchSize?: number;
  initialPollLookbackMs?: number;
  claimTtlMs?: number;
}

export interface TeamsDispatchResult {
  status: 'sent' | 'skipped' | 'failed';
  reason?: string;
  attempts?: number;
}

const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_POLLING_INTERVAL_MS = 15_000;
const DEFAULT_POLL_BATCH_SIZE = 50;
const DEFAULT_INITIAL_LOOKBACK_MS = 60_000;
const DEFAULT_CLAIM_TTL_MS = 5 * 60_000;
const MIN_CURSOR_ID = '';
const FAILURE_COMMENT_PREFIX = 'Microsoft Teams 전송 실패';
const ADAPTIVE_CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteFilterValue(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecentIso(isoString: string | null | undefined, ttlMs: number, nowMs: number) {
  if (!isoString) return false;
  const timestamp = Date.parse(isoString);
  if (Number.isNaN(timestamp)) return false;
  return nowMs - timestamp < ttlMs;
}

export function buildTeamsReplyPollingCursorFilter(createdAt: string, id: string): string {
  const quotedCreatedAt = quoteFilterValue(createdAt);
  const quotedId = quoteFilterValue(id || MIN_CURSOR_ID);
  return `created_at.gt.${quotedCreatedAt},and(created_at.eq.${quotedCreatedAt},id.gt.${quotedId})`;
}

export function buildTeamsMemoLink(appUrl: string | undefined, memoId: string): string {
  return buildAbsoluteMemoLink(memoId, appUrl);
}

export function isTeamsSourceMemo(metadata: unknown): metadata is Record<string, unknown> {
  return isObject(metadata) && metadata.source === 'teams' && typeof metadata.channel_id === 'string';
}

export function isFailureComment(content: string) {
  return content.trim().startsWith(FAILURE_COMMENT_PREFIX);
}

export function buildTeamsAdaptiveCard(content: string, memoLink: string) {
  return {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: content.trim() || '(빈 답신)',
        wrap: true,
      },
    ],
    actions: [
      {
        type: 'Action.OpenUrl',
        title: 'Sprintable에서 열기',
        url: memoLink,
      },
    ],
  };
}

async function postTeamsMessage(
  accessToken: string,
  params: {
    serviceUrl: string;
    conversationId: string;
    replyToId?: string | null;
    content: string;
    memoLink: string;
  },
  fetchFn: typeof fetch = fetch,
) {
  const serviceUrl = params.serviceUrl.replace(/\/$/, '');
  const path = params.replyToId
    ? `${serviceUrl}/v3/conversations/${params.conversationId}/activities/${encodeURIComponent(params.replyToId)}`
    : `${serviceUrl}/v3/conversations/${params.conversationId}/activities`;

  const response = await fetchFn(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      type: 'message',
      text: `${params.content}\n\n${params.memoLink}`,
      replyToId: params.replyToId ?? undefined,
      attachments: [
        {
          contentType: ADAPTIVE_CARD_CONTENT_TYPE,
          content: buildTeamsAdaptiveCard(params.content, params.memoLink),
        },
      ],
    }),
  });

  const json = await response.json().catch(() => ({})) as { id?: string; error?: { code?: string; message?: string } };
  return {
    ok: response.ok,
    status: response.status,
    error: json.error?.message ?? json.error?.code ?? `http_${response.status}`,
    id: json.id ?? null,
  };
}

export class TeamsOutboundDispatcher {
  private readonly logger: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly appUrl: string | undefined;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;
  private readonly pollingIntervalMs: number;
  private readonly pollBatchSize: number;
  private readonly claimTtlMs: number;
  private readonly inFlightReplyIds = new Set<string>();
  private readonly notifiedAuthFailures = new Set<string>();
  private channel: RealtimeChannel | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPolledAt: string;
  private lastPolledId = MIN_CURSOR_ID;

  constructor(private readonly options: TeamsOutboundDispatcherOptions) {
    this.logger = options.logger ?? console;
    this.fetchFn = options.fetchFn ?? fetch;
    this.appUrl = options.appUrl;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.pollingIntervalMs = options.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
    this.pollBatchSize = options.pollBatchSize ?? DEFAULT_POLL_BATCH_SIZE;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.lastPolledAt = new Date(Date.now() - (options.initialPollLookbackMs ?? DEFAULT_INITIAL_LOOKBACK_MS)).toISOString();
  }

  start() {
    if (!this.channel) {
      this.channel = this.options.supabase
        .channel(`teams-outbound-dispatcher-${Date.now()}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'memo_replies' }, (payload) => {
          const reply = payload.new as ReplyRow;
          void this.dispatchReplyIfNeeded(reply);
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            this.logger.info('[TeamsOutboundDispatcher] Realtime subscribed');
            return;
          }
          if (status === 'CHANNEL_ERROR' || status === 'CLOSED' || status === 'TIMED_OUT') {
            this.logger.warn(`[TeamsOutboundDispatcher] Realtime channel status: ${status}`);
          }
        });
    }

    if (!this.pollingTimer) {
      void this.pollOnce();
      this.pollingTimer = setInterval(() => {
        void this.pollOnce();
      }, this.pollingIntervalMs);
    }
  }

  async stop() {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    if (this.channel) {
      await this.options.supabase.removeChannel(this.channel);
      this.channel = null;
    }
  }

  async pollOnce() {
    try {
      const { data, error } = await this.options.supabase
        .from('memo_replies')
        .select('id, memo_id, content, created_by, created_at')
        .or(buildTeamsReplyPollingCursorFilter(this.lastPolledAt, this.lastPolledId))
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(this.pollBatchSize);

      if (error) {
        this.logger.error('[TeamsOutboundDispatcher] Polling failed:', error.message);
        return;
      }

      const replies = (data ?? []) as ReplyRow[];
      if (!replies.length) return;

      const lastReply = replies.at(-1);
      if (lastReply) {
        this.lastPolledAt = lastReply.created_at;
        this.lastPolledId = lastReply.id;
      }

      await Promise.allSettled(replies.map((reply) => this.dispatchReplyIfNeeded(reply)));
    } catch (error) {
      this.logger.error('[TeamsOutboundDispatcher] Polling threw:', error instanceof Error ? error.message : String(error));
    }
  }

  async dispatchReplyIfNeeded(reply: ReplyRow): Promise<TeamsDispatchResult> {
    if (this.inFlightReplyIds.has(reply.id)) {
      return { status: 'skipped', reason: 'reply_already_in_flight' };
    }
    if (isFailureComment(reply.content)) {
      return { status: 'skipped', reason: 'failure_comment' };
    }

    this.inFlightReplyIds.add(reply.id);
    try {
      const memo = await this.getMemo(reply.memo_id);
      if (!memo || !isTeamsSourceMemo(memo.metadata)) {
        return { status: 'skipped', reason: 'memo_not_teams_source' };
      }

      const isAgentReply = await this.isActiveAgentReply(memo.org_id, memo.project_id, reply.created_by);
      if (!isAgentReply) {
        return { status: 'skipped', reason: 'reply_not_from_active_agent' };
      }

      const claim = await this.claimReplyDispatch(reply, memo);
      if (claim.status !== 'owned') {
        if (claim.status === 'sent') return { status: 'skipped', reason: 'reply_already_dispatched' };
        if (claim.status === 'busy') return { status: 'skipped', reason: 'reply_dispatch_in_progress' };
        return { status: 'skipped', reason: 'reply_dispatch_failed_recently' };
      }

      const channelMapping = await this.getTeamsChannelMapping(memo.org_id, memo.project_id, String(memo.metadata.channel_id));
      if (!channelMapping) {
        await this.markReplyDispatchFailed(reply.id, claim.claimToken, 'teams_channel_mapping_missing');
        await this.recordFailure(reply, 'teams_channel_mapping_missing');
        return { status: 'failed', reason: 'teams_channel_mapping_missing', attempts: claim.attemptCount };
      }

      const teamsConfig = resolveTeamsBridgeConfig(channelMapping.config ?? null);
      const auth = await getActiveTeamsOrgAuth(this.options.supabase, memo.org_id);
      const appSecret = resolveTeamsAppSecret(auth?.access_token_ref);
      if (!auth || !teamsConfig.botAppId || !appSecret || isTeamsAuthExpired(auth.expires_at)) {
        await this.handleAuthFailed(memo.org_id, reply, claim.claimToken, 'auth_failed');
        return { status: 'failed', reason: 'auth_failed', attempts: claim.attemptCount };
      }
      this.notifiedAuthFailures.delete(memo.org_id);

      const serviceUrl = typeof memo.metadata.teams_service_url === 'string' ? memo.metadata.teams_service_url : null;
      const conversationId = typeof memo.metadata.teams_conversation_id === 'string' ? memo.metadata.teams_conversation_id : null;
      const replyToId = typeof memo.metadata.teams_activity_id === 'string' ? memo.metadata.teams_activity_id : null;
      if (!serviceUrl || !conversationId) {
        await this.markReplyDispatchFailed(reply.id, claim.claimToken, 'teams_activity_context_missing');
        await this.recordFailure(reply, 'teams_activity_context_missing');
        return { status: 'failed', reason: 'teams_activity_context_missing', attempts: claim.attemptCount };
      }

      const accessToken = await fetchTeamsAppAccessToken({
        botAppId: teamsConfig.botAppId,
        appSecret,
        fetchFn: this.fetchFn,
        logger: this.logger,
      }).catch(async (error) => {
        await this.handleAuthFailed(memo.org_id, reply, claim.claimToken, error instanceof Error ? error.message : 'auth_failed');
        return null;
      });
      if (!accessToken) {
        return { status: 'failed', reason: 'auth_failed', attempts: claim.attemptCount };
      }

      const memoLink = buildTeamsMemoLink(this.appUrl, memo.id);
      for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
        const result = await postTeamsMessage(accessToken, {
          serviceUrl,
          conversationId,
          replyToId,
          content: reply.content,
          memoLink,
        }, this.fetchFn);

        if (result.ok) {
          await this.markReplyDispatchSent(reply.id, claim.claimToken);
          return { status: 'sent', attempts: claim.attemptCount };
        }

        if (attempt < this.maxRetries) {
          this.logger.warn(`[TeamsOutboundDispatcher] Teams send failed (attempt ${attempt}/${this.maxRetries}): ${result.error}`);
          await wait(this.retryDelayMs);
          continue;
        }

        await this.markReplyDispatchFailed(reply.id, claim.claimToken, result.error);
        await this.recordFailure(reply, result.error);
        return { status: 'failed', reason: result.error, attempts: claim.attemptCount };
      }

      await this.markReplyDispatchFailed(reply.id, claim.claimToken, 'unknown_error');
      return { status: 'failed', reason: 'unknown_error', attempts: claim.attemptCount };
    } finally {
      this.inFlightReplyIds.delete(reply.id);
    }
  }

  private async getMemo(memoId: string): Promise<MemoRow | null> {
    const { data } = await this.options.supabase
      .from('memos')
      .select('id, org_id, project_id, metadata')
      .eq('id', memoId)
      .maybeSingle();

    return (data as MemoRow | null) ?? null;
  }

  private async getTeamsChannelMapping(orgId: string, projectId: string, channelId: string): Promise<ChannelMappingRow | null> {
    const { data } = await this.options.supabase
      .from('messaging_bridge_channels')
      .select('channel_id, config')
      .eq('org_id', orgId)
      .eq('project_id', projectId)
      .eq('platform', 'teams')
      .eq('channel_id', channelId)
      .eq('is_active', true)
      .maybeSingle();

    return (data as ChannelMappingRow | null) ?? null;
  }

  private async isActiveAgentReply(orgId: string, projectId: string, createdBy: string): Promise<boolean> {
    const { data } = await this.options.supabase
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

  private async getReplyDispatch(replyId: string): Promise<ReplyDispatchRow | null> {
    const { data, error } = await this.options.supabase
      .from('messaging_bridge_reply_dispatches')
      .select('id, status, attempt_count, claim_token, claimed_at, sent_at, error_message, updated_at')
      .eq('platform', 'teams')
      .eq('reply_id', replyId)
      .maybeSingle();

    if (error) throw error;
    return (data as ReplyDispatchRow | null) ?? null;
  }

  private async claimReplyDispatch(reply: ReplyRow, memo: MemoRow): Promise<
    | { status: 'owned'; claimToken: string; attemptCount: number }
    | { status: 'sent' | 'busy' | 'failed_recently' }
  > {
    const claimToken = globalThis.crypto.randomUUID();
    const now = new Date().toISOString();
    const insertRow = {
      org_id: memo.org_id,
      project_id: memo.project_id,
      memo_id: memo.id,
      reply_id: reply.id,
      platform: 'teams' as const,
      status: 'pending' as const,
      attempt_count: 1,
      claim_token: claimToken,
      claimed_at: now,
      error_message: null,
    };

    const { data: inserted, error: insertError } = await this.options.supabase
      .from('messaging_bridge_reply_dispatches')
      .insert(insertRow)
      .select('id, status, attempt_count, claim_token, claimed_at, sent_at, error_message, updated_at')
      .maybeSingle();

    if (!insertError && inserted) {
      return { status: 'owned', claimToken, attemptCount: 1 };
    }
    if (insertError && insertError.code !== '23505') throw insertError;

    const existing = await this.getReplyDispatch(reply.id);
    if (!existing) {
      return { status: 'owned', claimToken, attemptCount: 1 };
    }

    const nowMs = Date.now();
    if (existing.status === 'sent' || Boolean(existing.sent_at)) return { status: 'sent' };
    if (existing.status === 'pending' && isRecentIso(existing.claimed_at, this.claimTtlMs, nowMs)) return { status: 'busy' };
    if (existing.status === 'failed' && isRecentIso(existing.updated_at, this.claimTtlMs, nowMs)) return { status: 'failed_recently' };

    const nextAttemptCount = (existing.attempt_count ?? 0) + 1;
    const { data: reclaimed, error: reclaimError } = await this.options.supabase
      .from('messaging_bridge_reply_dispatches')
      .update({
        status: 'pending',
        attempt_count: nextAttemptCount,
        claim_token: claimToken,
        claimed_at: now,
        sent_at: null,
        error_message: null,
      })
      .eq('platform', 'teams')
      .eq('reply_id', reply.id)
      .eq('status', existing.status)
      .eq('updated_at', existing.updated_at)
      .select('id')
      .maybeSingle();

    if (reclaimError) throw reclaimError;
    if (!reclaimed) return { status: 'busy' };
    return { status: 'owned', claimToken, attemptCount: nextAttemptCount };
  }

  private async markReplyDispatchSent(replyId: string, claimToken: string) {
    const { error } = await this.options.supabase
      .from('messaging_bridge_reply_dispatches')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        error_message: null,
      })
      .eq('platform', 'teams')
      .eq('reply_id', replyId)
      .eq('claim_token', claimToken);

    if (error) throw error;
  }

  private async markReplyDispatchFailed(replyId: string, claimToken: string, reason: string) {
    const { error } = await this.options.supabase
      .from('messaging_bridge_reply_dispatches')
      .update({
        status: 'failed',
        error_message: reason,
        sent_at: null,
      })
      .eq('platform', 'teams')
      .eq('reply_id', replyId)
      .eq('claim_token', claimToken);

    if (error) throw error;
  }

  private async recordFailure(reply: ReplyRow, reason: string) {
    this.logger.error('[TeamsOutboundDispatcher] Microsoft Teams 전송 실패', {
      memo_id: reply.memo_id,
      reply_id: reply.id,
      reason,
    });

    const memoService = MemoService.fromSupabase(this.options.supabase);
    await memoService.addReply(
      reply.memo_id,
      `${FAILURE_COMMENT_PREFIX}\n- reply_id: ${reply.id}\n- reason: ${reason}`,
      reply.created_by,
    );
  }

  private async handleAuthFailed(orgId: string, reply: ReplyRow, claimToken: string, reason: string) {
    await this.markReplyDispatchFailed(reply.id, claimToken, reason);
    await this.recordFailure(reply, reason);
    if (this.notifiedAuthFailures.has(orgId)) return;
    this.notifiedAuthFailures.add(orgId);
    await notifyTeamsAuthFailed(this.options.supabase, orgId, reason);
  }
}
