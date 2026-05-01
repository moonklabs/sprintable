// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RealtimeChannel = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { AgentRoutingRuleService, RoutingPolicyError, type RoutingEvaluationResult, type RoutingRuleSummary } from './agent-routing-rule';
import { buildWebhookSignatureHeaders } from '@/lib/webhook-signature';
import { WebhookDeliveryService } from './webhook-delivery.service';

type DispatchSource = 'realtime' | 'polling';

type Logger = Pick<Console, 'info' | 'warn' | 'error'>;

interface MemoRow {
  id: string;
  org_id: string;
  project_id: string;
  title: string | null;
  content: string;
  memo_type: string;
  status: string;
  assigned_to: string | null;
  created_by: string;
  metadata?: Record<string, unknown> | null;
  updated_at: string;
  created_at: string;
}

interface TeamMemberRow {
  id: string;
  org_id: string;
  project_id: string;
  type: string;
  name: string;
  webhook_url: string | null;
  is_active: boolean;
}

interface AgentDeploymentRow {
  id: string;
  model: string | null;
  runtime: string;
  status: string;
  config: Record<string, unknown> | null;
}

interface RoutingPayload {
  rule_id: string;
  auto_reply_mode: 'process_and_forward' | 'process_and_report';
  forward_to_agent_id: string | null;
  original_assigned_to: string | null;
  target_runtime: string;
  target_model: string | null;
}

interface WebhookConfigRow {
  url: string;
  secret: string | null;
  channel: OutboundWebhookFormat;
}

type OutboundWebhookFormat = 'discord' | 'google' | 'slack' | 'generic';
type AgentExecutionStatus = 'completed' | 'failed' | 'held' | 'hitl';

export interface MemoEventDispatcherOptions {
  supabase: SupabaseClient;
  logger?: Logger;
  fetchFn?: typeof fetch;
  pollingIntervalMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  pollBatchSize?: number;
  initialPollLookbackMs?: number;
  webhookTimeoutMs?: number;
  routingRuleService?: Pick<AgentRoutingRuleService, 'evaluateMemo'>;
}

export interface DispatchResult {
  status: 'dispatched' | 'skipped' | 'duplicate' | 'failed';
  reason?: string;
  runId?: string;
}

const DEFAULT_POLLING_INTERVAL_MS = 15_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 60_000;
const DEFAULT_POLL_BATCH_SIZE = 50;
const DEFAULT_INITIAL_LOOKBACK_MS = 60_000;
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
const MIN_UUID = '00000000-0000-0000-0000-000000000000';

export function buildMemoDispatchKey(memo: Pick<MemoRow, 'id' | 'assigned_to' | 'updated_at'>): string {
  return `memo:${memo.id}:assignee:${memo.assigned_to ?? 'unassigned'}:updated:${memo.updated_at}`;
}

function quoteFilterValue(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function buildPollingCursorFilter(updatedAt: string, id: string): string {
  const quotedUpdatedAt = quoteFilterValue(updatedAt);
  const quotedId = quoteFilterValue(id || MIN_UUID);
  return `updated_at.gt.${quotedUpdatedAt},and(updated_at.eq.${quotedUpdatedAt},id.gt.${quotedId})`;
}

function isForwardedRoutingMemo(memo: MemoRow): boolean {
  const metadata = memo.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return false;
  }

  const routing = (metadata as Record<string, unknown>).routing;
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) {
    return false;
  }

  const sourceMemoId = (routing as Record<string, unknown>).source_memo_id;
  return typeof sourceMemoId === 'string' && sourceMemoId.trim().length > 0;
}

async function fetchWithTimeout(fetchFn: typeof fetch, input: string, init: RequestInit, timeoutMs: number) {
  const signal = AbortSignal.timeout(timeoutMs);
  return fetchFn(input, { ...init, signal });
}

function detectWebhookFormat(url: string): OutboundWebhookFormat {
  if (url.includes('/api/webhooks') && (url.includes('discord.com') || url.includes('discordapp.com'))) {
    return 'discord';
  }

  if (url.includes('chat.googleapis.com')) {
    return 'google';
  }

  if (url.includes('hooks.slack.com')) {
    return 'slack';
  }

  return 'generic';
}

function truncateText(value: string | null | undefined, maxLength: number, fallback: string): string {
  const normalized = value?.trim() || fallback;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function isAgentExecutionStatus(value: unknown): value is AgentExecutionStatus {
  return value === 'completed' || value === 'failed' || value === 'held' || value === 'hitl';
}

function extractAgentExecutionStatus(payload: unknown): AgentExecutionStatus | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const nestedStatus = (data as Record<string, unknown>).status;
  return isAgentExecutionStatus(nestedStatus) ? nestedStatus : null;
}

function getDispatchFailureSummary(eventType: string): string {
  if (eventType === 'agent_webhook_missing') {
    return 'Run failed because no agent webhook is configured';
  }
  if (eventType === 'agent_webhook_invalid_content_type') {
    return 'Run failed because the agent webhook did not return JSON';
  }
  if (eventType === 'agent_webhook_exception') {
    return 'Run failed because the agent webhook request threw an exception';
  }
  if (eventType === 'deployment_failed') {
    return 'Run failed because the deployment is in DEPLOY_FAILED state';
  }
  if (eventType === 'deployment_terminated') {
    return 'Run failed because the deployment is terminated';
  }

  const webhookStatus = eventType.match(/^agent_webhook_(\d{3})$/)?.[1];
  if (webhookStatus) {
    return `Run failed because the agent webhook responded with HTTP ${webhookStatus}`;
  }

  return eventType.replace(/_/g, ' ');
}

export class MemoEventDispatcher {
  private readonly logger: Logger;
  private readonly fetchFn: typeof fetch;
  private readonly pollingIntervalMs: number;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly pollBatchSize: number;
  private readonly webhookTimeoutMs: number;
  private readonly routingRuleService: Pick<AgentRoutingRuleService, 'evaluateMemo'>;
  private readonly inFlightKeys = new Set<string>();

  private channel: RealtimeChannel | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private lastPolledAt: string;
  private lastPolledId = MIN_UUID;
  private stopped = false;

  constructor(private readonly options: MemoEventDispatcherOptions) {
    this.logger = options.logger ?? console;
    this.fetchFn = options.fetchFn ?? fetch;
    this.pollingIntervalMs = options.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
    this.pollBatchSize = options.pollBatchSize ?? DEFAULT_POLL_BATCH_SIZE;
    this.webhookTimeoutMs = options.webhookTimeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
    this.routingRuleService = options.routingRuleService ?? new AgentRoutingRuleService(options.supabase);
    this.lastPolledAt = new Date(Date.now() - (options.initialPollLookbackMs ?? DEFAULT_INITIAL_LOOKBACK_MS)).toISOString();
  }

  start() {
    this.stopped = false;
    this.subscribe();
    void this.pollOnce();
    this.startPolling();
  }

  async stop() {
    this.stopped = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

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
        .from('memos')
        .select('id, org_id, project_id, title, content, memo_type, status, assigned_to, created_by, metadata, updated_at, created_at')
        .eq('status', 'open')
        .not('assigned_to', 'is', null)
        .or(buildPollingCursorFilter(this.lastPolledAt, this.lastPolledId))
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(this.pollBatchSize);

      if (error) {
        this.logger.error('[MemoEventDispatcher] Polling failed:', error.message);
        return;
      }

      const memos = (data ?? []) as MemoRow[];
      if (!memos.length) return;

      const lastMemo = memos[memos.length - 1];
      if (lastMemo) {
        this.lastPolledAt = lastMemo.updated_at;
        this.lastPolledId = lastMemo.id;
      }

      await Promise.allSettled(memos.map((memo) => this.dispatchMemoIfNeeded(memo, 'polling')));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('[MemoEventDispatcher] Polling threw:', message);
    }
  }

  async dispatchMemoIfNeeded(memo: MemoRow, source: DispatchSource): Promise<DispatchResult> {
    const dispatchKey = buildMemoDispatchKey(memo);
    if (this.inFlightKeys.has(dispatchKey)) {
      return { status: 'duplicate', reason: 'dispatch_already_in_flight' };
    }

    this.inFlightKeys.add(dispatchKey);
    try {
      return await this.dispatchMemo(memo, source, dispatchKey);
    } finally {
      this.inFlightKeys.delete(dispatchKey);
    }
  }

  private startPolling() {
    if (this.pollingTimer) return;
    this.pollingTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollingIntervalMs);
  }

  private subscribe() {
    if (this.stopped) return;

    const supabase = this.options.supabase;
    if (this.channel) {
      void supabase.removeChannel(this.channel);
      this.channel = null;
    }

    const channel = supabase
      .channel(`memo-event-dispatcher-${Date.now()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'memos' }, (payload) => {
        const memo = payload.new as MemoRow;
        void this.dispatchMemoIfNeeded(memo, 'realtime');
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'memos' }, (payload) => {
        const memo = payload.new as MemoRow;
        void this.dispatchMemoIfNeeded(memo, 'realtime');
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          this.reconnectAttempt = 0;
          this.logger.info('[MemoEventDispatcher] Realtime subscribed');
          return;
        }

        if (status === 'CHANNEL_ERROR' || status === 'CLOSED' || status === 'TIMED_OUT') {
          this.logger.warn(`[MemoEventDispatcher] Realtime disconnected (${status}), scheduling reconnect`);
          this.scheduleReconnect();
        }
      });

    this.channel = channel;
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;

    const delay = Math.min(
      this.reconnectBaseDelayMs * (2 ** this.reconnectAttempt),
      this.reconnectMaxDelayMs,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt += 1;
      this.subscribe();
    }, delay);
  }

  private async dispatchMemo(memo: MemoRow, source: DispatchSource, dispatchKey: string): Promise<DispatchResult> {
    if (!memo.assigned_to || memo.status !== 'open') {
      return { status: 'skipped', reason: 'memo_not_open_or_unassigned' };
    }

    let routing: RoutingEvaluationResult;
    let routingFallbackReason: 'no_matching_rule' | 'evaluation_failed' | null = null;
    if (isForwardedRoutingMemo(memo)) {
      routing = {
        matchedRule: null,
        dispatchAgentId: memo.assigned_to,
        originalAssignedTo: memo.assigned_to,
        autoReplyMode: 'process_and_report',
        forwardToAgentId: null,
      };
    } else {
      try {
        routing = await this.routingRuleService.evaluateMemo({
          id: memo.id,
          org_id: memo.org_id,
          project_id: memo.project_id,
          memo_type: memo.memo_type,
          assigned_to: memo.assigned_to,
        });
        if (!routing.matchedRule && routing.originalAssignedTo) {
          routingFallbackReason = 'no_matching_rule';
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'routing_rule_evaluation_failed';
        if (error instanceof RoutingPolicyError) {
          await this.logAudit(error.details.agentId ?? memo.assigned_to, memo, 'memo_dispatch.routing_policy_blocked', 'warn', {
            dispatch_key: dispatchKey,
            error_code: error.code,
            error: message,
            rule_id: error.details.ruleId ?? null,
            target_agent_id: error.details.targetAgentId ?? null,
          });
          return { status: 'skipped', reason: error.code };
        }
        await this.logAudit(memo.assigned_to, memo, 'memo_dispatch.routing_rule_evaluation_failed', 'error', {
          dispatch_key: dispatchKey,
          error: message,
        });
        routing = {
          matchedRule: null,
          dispatchAgentId: memo.assigned_to,
          originalAssignedTo: memo.assigned_to,
          autoReplyMode: 'process_and_report',
          forwardToAgentId: null,
        };
        routingFallbackReason = 'evaluation_failed';
      }
    }

    if (routingFallbackReason && routing.originalAssignedTo) {
      await this.logAudit(routing.originalAssignedTo, memo, 'memo_dispatch.routing_rule_fallback_to_original_assignee', 'info', {
        dispatch_key: dispatchKey,
        reason: routingFallbackReason,
      });
    }

    if (!routing.dispatchAgentId) {
      return { status: 'skipped', reason: 'routing_target_missing' };
    }

    if (memo.created_by === routing.dispatchAgentId) {
      // forwardToAgentId가 있고 redirect target도 self-loop가 아닌 경우에만 redirect
      if (routing.forwardToAgentId && routing.forwardToAgentId !== memo.created_by) {
        await this.logAudit(routing.dispatchAgentId, memo, 'memo_dispatch.self_loop_redirect', 'info', {
          dispatch_key: dispatchKey,
          from_agent_id: routing.dispatchAgentId,
          to_agent_id: routing.forwardToAgentId,
        });
        routing = { ...routing, dispatchAgentId: routing.forwardToAgentId, forwardToAgentId: null };
      } else {
        return { status: 'skipped', reason: 'self_loop_prevented' };
      }
    }

    if (!routing.dispatchAgentId) {
      return { status: 'skipped', reason: 'routing_target_missing' };
    }

    // managed agent 조회 → 없으면 BYOA fallback (webhook_url 있는 팀 멤버)
    let agent = await this.getAgentById(memo, routing.dispatchAgentId);
    const isByoa = !agent;
    if (!agent) {
      agent = await this.getByoaMember(memo, routing.dispatchAgentId);
    }
    if (!agent) {
      await this.postSystemReply(
        memo,
        routing.dispatchAgentId,
        `⚠️ 에이전트(${routing.dispatchAgentId})가 비활성 상태이거나 배포가 구성되지 않아 웹훅 발송이 스킵되었습니다.`,
      );
      return { status: 'skipped', reason: 'assignee_not_active_agent' };
    }

    // BYOA: webhook_url로 직접 발송 + agent_run 경량 추적 + webhook_deliveries 재시도 큐
    if (isByoa) {
      const webhook = await this.resolveWebhook(agent, memo.project_id);
      if (!webhook) {
        await this.logAudit(agent.id, memo, 'memo_dispatch.byoa_webhook_missing', 'warn', {
          dispatch_key: dispatchKey,
        });
        return { status: 'skipped', reason: 'byoa_webhook_missing' };
      }

      try {
        const outbound = this.buildWebhookPayload({
          webhookUrl: webhook.url,
          webhookChannel: webhook.channel,
          memo,
          agent,
          deploymentId: null,
          runId: dispatchKey,
          source,
          dispatchKey,
          routing,
        });
        const bodyStr = JSON.stringify(outbound.body);
        // webhook_deliveries 재시도 큐 경유 발송
        const deliveryService = new WebhookDeliveryService(this.options.supabase);
        const success = await deliveryService.dispatch({
          org_id: memo.org_id,
          webhook_config_id: null,
          event_type: 'memo.received',
          url: webhook.url,
          headers: {
            'Content-Type': 'application/json',
            ...buildWebhookSignatureHeaders(webhook.secret, bodyStr),
          },
          body: bodyStr,
          fetchFn: this.fetchFn,
        });
        if (!success) {
          this.logger.warn('[MemoEventDispatcher] BYOA webhook dispatch failed after retries', {
            agent_id: agent.id,
            memo_id: memo.id,
          });
          return { status: 'failed', reason: 'byoa_webhook_failed' };
        }
        return { status: 'dispatched' };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown_dispatch_error';
        this.logger.error('[MemoEventDispatcher] BYOA webhook exception', {
          agent_id: agent.id,
          memo_id: memo.id,
          error: message,
        });
        return { status: 'failed', reason: 'byoa_webhook_exception' };
      }
    }

    const deployment = routing.matchedRule?.deployment_id
      ? await this.getDeploymentById(memo, agent.id, routing.matchedRule.deployment_id)
      : await this.getLatestDeployment(memo, agent.id);
    const initialRunStatus = deployment?.status === 'DEPLOYING'
      ? 'queued'
      : deployment?.status === 'SUSPENDED'
        ? 'held'
        : 'running';

    const run = await this.createRun(
      memo,
      agent.id,
      deployment?.id ?? null,
      routing.matchedRule?.target_model ?? deployment?.model ?? null,
      dispatchKey,
      initialRunStatus,
      initialRunStatus === 'queued'
        ? 'Queued while deployment is deploying'
        : initialRunStatus === 'held'
          ? 'Queued while deployment is suspended'
          : undefined,
    );
    if ('status' in run) {
      return run;
    }

    if (deployment?.status === 'DEPLOYING') {
      await this.logAudit(agent.id, memo, 'memo_dispatch.deployment_queue_held', 'info', {
        run_id: run.id,
        deployment_id: deployment.id,
        deployment_status: deployment.status,
      });
      return { status: 'skipped', reason: 'deployment_deploying_queued', runId: run.id };
    }

    if (deployment?.status === 'SUSPENDED') {
      await this.logAudit(agent.id, memo, 'memo_dispatch.deployment_queue_suspended', 'warn', {
        run_id: run.id,
        deployment_id: deployment.id,
        deployment_status: deployment.status,
      });
      return { status: 'skipped', reason: 'deployment_suspended_held', runId: run.id };
    }

    if (deployment && (deployment.status === 'DEPLOY_FAILED' || deployment.status === 'TERMINATED')) {
      await this.failRun(
        run.id,
        agent.id,
        memo,
        deployment.status === 'DEPLOY_FAILED' ? 'deployment_failed' : 'deployment_terminated',
      );
      return {
        status: 'failed',
        reason: deployment.status === 'DEPLOY_FAILED' ? 'deployment_failed' : 'deployment_terminated',
        runId: run.id,
      };
    }

    const webhook = await this.resolveWebhook(agent, memo.project_id);
    if (!webhook) {
      await this.failRun(run.id, agent.id, memo, 'agent_webhook_missing');
      return { status: 'failed', reason: 'agent_webhook_missing', runId: run.id };
    }

    try {
      const outbound = this.buildWebhookPayload({
        webhookUrl: webhook.url,
        webhookChannel: webhook.channel,
        memo,
        agent,
        deploymentId: deployment?.id ?? null,
        runId: run.id,
        source,
        dispatchKey,
        routing,
      });
      const response = await fetchWithTimeout(
        this.fetchFn,
        webhook.url,
        {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'Content-Type': 'application/json',
            ...buildWebhookSignatureHeaders(webhook.secret, JSON.stringify(outbound.body)),
          },
          body: JSON.stringify(outbound.body),
        },
        this.webhookTimeoutMs,
      );

      if (!response.ok) {
        const body = await response.text();
        await this.failRun(run.id, agent.id, memo, `agent_webhook_${response.status}`, body);
        return { status: 'failed', reason: `agent_webhook_${response.status}`, runId: run.id };
      }

      let executionStatus: AgentExecutionStatus | null = null;
      if (outbound.format === 'generic') {
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        if (!contentType.includes('application/json')) {
          const body = (await response.text()).slice(0, 1000);
          await this.failRun(run.id, agent.id, memo, 'agent_webhook_invalid_content_type', body);
          return { status: 'failed', reason: 'agent_webhook_invalid_content_type', runId: run.id };
        }

        const payload = await response.clone().json().catch(() => null);
        executionStatus = extractAgentExecutionStatus(payload);
      }

      if (executionStatus) {
        return {
          status: executionStatus === 'failed' ? 'failed' : 'dispatched',
          reason: executionStatus === 'failed' ? 'agent_execution_failed' : undefined,
          runId: run.id,
        };
      }

      await this.options.supabase
        .from('agent_runs')
        .update({
          status: 'completed',
          result_summary: 'memo dispatch enqueued',
          finished_at: new Date().toISOString(),
        })
        .eq('id', run.id);

      return { status: 'dispatched', runId: run.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_dispatch_error';
      await this.failRun(run.id, agent.id, memo, 'agent_webhook_exception', message);
      return { status: 'failed', reason: 'agent_webhook_exception', runId: run.id };
    }
  }

  private buildWebhookPayload(input: {
    webhookUrl: string;
    webhookChannel?: OutboundWebhookFormat | null;
    memo: MemoRow;
    agent: TeamMemberRow;
    deploymentId: string | null;
    runId: string;
    source: DispatchSource;
    dispatchKey: string;
    routing: RoutingEvaluationResult;
  }): { format: OutboundWebhookFormat; body: Record<string, unknown> } {
    const { webhookUrl, webhookChannel, memo, agent, deploymentId, runId, source, dispatchKey, routing } = input;
    const format = webhookChannel ?? detectWebhookFormat(webhookUrl);
    const title = truncateText(memo.title, 256, 'New assigned memo');
    const description = truncateText(memo.content, 4000, '(no content)');
    const internalPayload = {
      event: 'memo.assigned',
      data: {
        run_id: runId,
        memo_id: memo.id,
        project_id: memo.project_id,
        org_id: memo.org_id,
        agent_id: agent.id,
        agent_name: agent.name,
        deployment_id: deploymentId,
        source,
        dispatch_key: dispatchKey,
        routing: this.buildRoutingPayload(routing.matchedRule, routing),
        memo: {
          id: memo.id,
          title: memo.title,
          content: memo.content,
          memo_type: memo.memo_type,
          created_by: memo.created_by,
          assigned_to: memo.assigned_to,
          updated_at: memo.updated_at,
          created_at: memo.created_at,
        },
      },
    };

    if (format === 'discord') {
      return {
        format,
        body: {
          embeds: [{
            title,
            description: description.substring(0, 4000),
            color: 0x3B82F6,
            fields: [
              { name: 'Agent', value: agent.name ?? 'Unknown', inline: true },
              { name: 'Type', value: memo.memo_type ?? 'memo', inline: true },
            ],
            timestamp: memo.created_at,
          }],
        },
      };
    }

    if (format === 'google' || format === 'slack') {
      return {
        format,
        body: {
          text: `*${title}*\n${description}`,
        },
      };
    }

    return { format, body: internalPayload };
  }

  private buildRoutingPayload(matchedRule: RoutingRuleSummary | null, routing: RoutingEvaluationResult): RoutingPayload | null {
    if (!matchedRule) return null;
    return {
      rule_id: matchedRule.id,
      auto_reply_mode: routing.autoReplyMode,
      forward_to_agent_id: routing.forwardToAgentId,
      original_assigned_to: routing.originalAssignedTo,
      target_runtime: matchedRule.target_runtime,
      target_model: matchedRule.target_model,
    };
  }

  private async getAgentById(memo: MemoRow, agentId: string): Promise<TeamMemberRow | null> {
    const { data, error } = await this.options.supabase
      .from('team_members')
      .select('id, org_id, project_id, type, name, webhook_url, is_active')
      .eq('id', agentId)
      .eq('org_id', memo.org_id)
      .eq('project_id', memo.project_id)
      .single();

    if (error || !data) return null;
    const member = data as TeamMemberRow;
    if (member.type !== 'agent' || !member.is_active) return null;
    return member;
  }

  /** BYOA fallback: deployment 없어도 webhook_url이 있는 팀 멤버 반환 */
  private async getByoaMember(memo: MemoRow, memberId: string): Promise<TeamMemberRow | null> {
    const { data, error } = await this.options.supabase
      .from('team_members')
      .select('id, org_id, project_id, type, name, webhook_url, is_active')
      .eq('id', memberId)
      .eq('org_id', memo.org_id)
      .eq('project_id', memo.project_id)
      .not('webhook_url', 'is', null)
      .single();

    if (error || !data) return null;
    return data as TeamMemberRow;
  }

  private async getDeploymentById(memo: MemoRow, agentId: string, deploymentId: string): Promise<AgentDeploymentRow | null> {
    const { data } = await this.options.supabase
      .from('agent_deployments')
      .select('id, model, runtime, status, config')
      .eq('id', deploymentId)
      .eq('org_id', memo.org_id)
      .eq('project_id', memo.project_id)
      .eq('agent_id', agentId)
      .is('deleted_at', null)
      .maybeSingle();

    return (data as AgentDeploymentRow | null) ?? null;
  }

  private async getLatestDeployment(memo: MemoRow, agentId: string): Promise<AgentDeploymentRow | null> {
    const { data } = await this.options.supabase
      .from('agent_deployments')
      .select('id, model, runtime, status, config')
      .eq('org_id', memo.org_id)
      .eq('project_id', memo.project_id)
      .eq('agent_id', agentId)
      .is('deleted_at', null)
      .order('last_deployed_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return (data as AgentDeploymentRow | null) ?? null;
  }

  private async resolveWebhook(agent: TeamMemberRow, projectId: string): Promise<WebhookConfigRow | { url: string; secret: null; channel: null } | null> {
    const supabase = this.options.supabase;
    const { data: projectConfig } = await supabase
      .from('webhook_configs')
      .select('url, secret, channel')
      .eq('org_id', agent.org_id)
      .eq('member_id', agent.id)
      .eq('project_id', projectId)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (projectConfig?.url) return projectConfig as WebhookConfigRow;

    const { data: defaultConfig } = await supabase
      .from('webhook_configs')
      .select('url, secret, channel')
      .eq('org_id', agent.org_id)
      .eq('member_id', agent.id)
      .is('project_id', null)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (defaultConfig?.url) return defaultConfig as WebhookConfigRow;
    if (agent.webhook_url) return { url: agent.webhook_url, secret: null, channel: null };
    return null;
  }

  private async createRun(
    memo: MemoRow,
    agentId: string,
    deploymentId: string | null,
    model: string | null,
    dispatchKey: string,
    status: 'queued' | 'held' | 'running',
    resultSummary?: string,
  ): Promise<{ id: string } | DispatchResult> {
    const { data, error } = await this.options.supabase
      .from('agent_runs')
      .insert({
        org_id: memo.org_id,
        project_id: memo.project_id,
        agent_id: agentId,
        deployment_id: deploymentId,
        memo_id: memo.id,
        trigger: 'memo_realtime_dispatch',
        model,
        status,
        result_summary: resultSummary ?? null,
        started_at: status === 'running' ? new Date().toISOString() : null,
        dispatch_key: dispatchKey,
        source_updated_at: memo.updated_at,
      })
      .select('id')
      .single();

    if (error) {
      if (error.code === '23505') {
        return { status: 'duplicate', reason: 'dispatch_key_conflict' };
      }

      await this.logAudit(agentId, memo, 'memo_dispatch.run_insert_failed', 'error', {
        dispatch_key: dispatchKey,
        error: error.message,
      });
      return { status: 'failed', reason: 'run_insert_failed' };
    }

    return { id: data.id as string };
  }

  private async failRun(runId: string, agentId: string, memo: MemoRow, eventType: string, details?: string) {
    const resultSummary = getDispatchFailureSummary(eventType);
    const errorMessage = details?.trim() || resultSummary;

    await this.options.supabase
      .from('agent_runs')
      .update({
        status: 'failed',
        last_error_code: eventType,
        error_message: errorMessage,
        result_summary: resultSummary,
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId);

    await this.logAudit(agentId, memo, eventType, 'error', {
      run_id: runId,
      details,
    });
  }

  private async postSystemReply(memo: MemoRow, createdBy: string, content: string) {
    const { error } = await this.options.supabase
      .from('memo_replies')
      .insert({ memo_id: memo.id, content, created_by: createdBy, review_type: 'system' });
    if (error) {
      this.logger.warn('[MemoEventDispatcher] Failed to post system reply:', error.message);
    }
  }

  private async logAudit(
    agentId: string,
    memo: MemoRow,
    eventType: string,
    severity: 'info' | 'warn' | 'error' | 'security' | 'debug',
    payload: Record<string, unknown>,
  ) {
    const { error } = await this.options.supabase
      .from('agent_audit_logs')
      .insert({
        org_id: memo.org_id,
        project_id: memo.project_id,
        agent_id: agentId,
        event_type: eventType,
        severity,
        summary: `${eventType} for memo ${memo.id}`,
        payload,
      });

    if (error) {
      this.logger.error('[MemoEventDispatcher] Failed to log audit:', error.message);
    }
  }
}
