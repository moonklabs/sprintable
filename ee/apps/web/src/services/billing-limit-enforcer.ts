import type { SupabaseClient } from '@supabase/supabase-js';
import { fireWebhooks } from './webhook-notify';
import { isExpiredIsoTimestamp, resolveMessagingBridgeSecretRef } from './slack-channel-mapping';
import { getUsageMonthRange } from './monthly-agent-usage';
import { getEntitlementBearingSubscription } from '@/lib/billing-policy';

interface BillingLimitRow {
  monthly_cap_cents: number | null;
  daily_cap_cents: number | null;
  alert_threshold_pct: number | null;
}

interface SubscriptionRow {
  tier_id: string;
}

interface TeamMemberRecipientRow {
  id: string;
  user_id: string | null;
}

interface AdminAlertRecipient extends TeamMemberRecipientRow {
  email: string;
}

interface AlertRow {
  org_id: string;
  usage_month: string;
  alert_type: string;
  threshold_pct: number | null;
}

interface SlackAuthRow {
  access_token_ref: string;
  expires_at: string | null;
}

interface SlackChannelRow {
  channel_id: string;
}

interface BillingLimitDeps {
  fetchFn?: typeof fetch;
  fireWebhooksFn?: typeof fireWebhooks;
  now?: () => Date;
}

export interface BillingLimitSettings {
  monthlyCapCents: number | null;
  dailyCapCents: number | null;
  alertThresholdPct: number;
  source: 'explicit' | 'plan_default';
  tierName: string;
}

export interface BillingPreExecutionResult {
  status: 'allow' | 'daily_cap_exceeded' | 'monthly_cap_exceeded';
  reason: string | null;
}

export interface BillingPostExecutionResult {
  thresholdAlertSent: boolean;
  monthlyCapExceeded: boolean;
  suspendedDeploymentCount: number;
}

export interface BillingLimitsInput {
  monthlyCapCents?: number | null;
  dailyCapCents?: number | null;
  alertThresholdPct?: number;
}

interface ExecutionScope {
  id: string;
  org_id: string;
  project_id: string;
  agent_id: string;
  memo_id: string | null;
}

interface MemoScope {
  id: string;
  title: string | null;
}

const DEFAULT_ALERT_THRESHOLD_PCT = 80;
const FREE_PLAN_DEFAULT_MONTHLY_CAP_CENTS = 1_000;
const DAILY_LIMIT_REPLY = '일일 한도 초과, 내일 재개';
const DAILY_LIMIT_ERROR_CODE = 'billing_daily_cap_exceeded';
const MONTHLY_LIMIT_ERROR_CODE = 'billing_monthly_cap_exceeded';
const MONTHLY_THRESHOLD_ALERT_PREFIX = 'threshold';
const MONTHLY_LIMIT_ALERT_TYPE = 'monthly_cap_exceeded';
const RESEND_API_URL = 'https://api.resend.com/emails';

function normalizeCap(value: number | null | undefined): number | null {
  if (value == null || value <= 0) return null;
  return value;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfNextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function buildThresholdAlertType(thresholdPct: number) {
  return `${MONTHLY_THRESHOLD_ALERT_PREFIX}_${thresholdPct}`;
}

function defaultPlanLimits(tierName: string): BillingLimitSettings {
  if (tierName === 'free') {
    return {
      monthlyCapCents: FREE_PLAN_DEFAULT_MONTHLY_CAP_CENTS,
      dailyCapCents: null,
      alertThresholdPct: DEFAULT_ALERT_THRESHOLD_PCT,
      source: 'plan_default',
      tierName,
    };
  }

  return {
    monthlyCapCents: null,
    dailyCapCents: null,
    alertThresholdPct: DEFAULT_ALERT_THRESHOLD_PCT,
    source: 'plan_default',
    tierName,
  };
}

export class BillingLimitEnforcer {
  private readonly fetchFn: typeof fetch;
  private readonly fireWebhooksFn: typeof fireWebhooks;
  private readonly now: () => Date;

  constructor(
    private readonly supabase: SupabaseClient,
    deps: BillingLimitDeps = {},
  ) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.fireWebhooksFn = deps.fireWebhooksFn ?? fireWebhooks;
    this.now = deps.now ?? (() => new Date());
  }

  async getResolvedSettings(orgId: string): Promise<BillingLimitSettings> {
    const [limitResult, tierName] = await Promise.all([
      this.supabase
        .from('billing_limits')
        .select('monthly_cap_cents, daily_cap_cents, alert_threshold_pct')
        .eq('org_id', orgId)
        .maybeSingle(),
      this.getTierName(orgId),
    ]);

    if (limitResult.error) throw limitResult.error;
    const limit = (limitResult.data as BillingLimitRow | null) ?? null;

    if (!limit) {
      return defaultPlanLimits(tierName);
    }

    return {
      monthlyCapCents: normalizeCap(limit.monthly_cap_cents),
      dailyCapCents: normalizeCap(limit.daily_cap_cents),
      alertThresholdPct: limit.alert_threshold_pct ?? DEFAULT_ALERT_THRESHOLD_PCT,
      source: 'explicit',
      tierName,
    };
  }

  async saveSettings(orgId: string, input: BillingLimitsInput): Promise<BillingLimitSettings> {
    const { data: existing, error: existingError } = await this.supabase
      .from('billing_limits')
      .select('monthly_cap_cents, daily_cap_cents, alert_threshold_pct')
      .eq('org_id', orgId)
      .maybeSingle();

    if (existingError) throw existingError;
    const current = (existing as BillingLimitRow | null) ?? null;
    const patch = {
      org_id: orgId,
      monthly_cap_cents: input.monthlyCapCents === undefined
        ? normalizeCap(current?.monthly_cap_cents ?? null)
        : normalizeCap(input.monthlyCapCents),
      daily_cap_cents: input.dailyCapCents === undefined
        ? normalizeCap(current?.daily_cap_cents ?? null)
        : normalizeCap(input.dailyCapCents),
      alert_threshold_pct: input.alertThresholdPct ?? current?.alert_threshold_pct ?? DEFAULT_ALERT_THRESHOLD_PCT,
    };

    const { error } = await this.supabase
      .from('billing_limits')
      .upsert(patch, { onConflict: 'org_id' });

    if (error) throw error;
    return this.getResolvedSettings(orgId);
  }

  async enforceBeforeRun(input: { run: ExecutionScope; memo: MemoScope }): Promise<BillingPreExecutionResult> {
    const settings = await this.getResolvedSettings(input.run.org_id);
    const usage = await this.getUsage(input.run.org_id);

    if (settings.monthlyCapCents != null && usage.monthlySpentCents >= settings.monthlyCapCents) {
      const suspendedDeploymentCount = await this.suspendOrgDeployments(input.run.org_id);
      await this.sendMonthlyCapExceededAlerts({
        orgId: input.run.org_id,
        memoId: input.memo.id,
        spentCents: usage.monthlySpentCents,
        capCents: settings.monthlyCapCents,
        usageMonth: usage.usageMonth,
        suspendedDeploymentCount,
      });

      return {
        status: 'monthly_cap_exceeded',
        reason: '월 한도 초과로 조직 에이전트를 자동 정지했습니다.',
      };
    }

    if (settings.dailyCapCents != null && usage.dailySpentCents >= settings.dailyCapCents) {
      await this.supabase.from('memo_replies').insert({
        memo_id: input.memo.id,
        content: DAILY_LIMIT_REPLY,
        created_by: input.run.agent_id,
      });

      return {
        status: 'daily_cap_exceeded',
        reason: DAILY_LIMIT_REPLY,
      };
    }

    return { status: 'allow', reason: null };
  }

  async enforceAfterRun(input: { run: ExecutionScope; memo: MemoScope }): Promise<BillingPostExecutionResult> {
    const settings = await this.getResolvedSettings(input.run.org_id);
    const usage = await this.getUsage(input.run.org_id);
    let thresholdAlertSent = false;
    let monthlyCapExceeded = false;
    let suspendedDeploymentCount = 0;

    if (settings.monthlyCapCents != null) {
      const thresholdAmount = Math.ceil((settings.monthlyCapCents * settings.alertThresholdPct) / 100);
      if (usage.monthlySpentCents >= thresholdAmount) {
        thresholdAlertSent = await this.sendThresholdAlert({
          orgId: input.run.org_id,
          memoId: input.memo.id,
          spentCents: usage.monthlySpentCents,
          capCents: settings.monthlyCapCents,
          thresholdPct: settings.alertThresholdPct,
          usageMonth: usage.usageMonth,
        });
      }

      if (usage.monthlySpentCents > settings.monthlyCapCents) {
        monthlyCapExceeded = true;
        suspendedDeploymentCount = await this.suspendOrgDeployments(input.run.org_id);
        await this.sendMonthlyCapExceededAlerts({
          orgId: input.run.org_id,
          memoId: input.memo.id,
          spentCents: usage.monthlySpentCents,
          capCents: settings.monthlyCapCents,
          usageMonth: usage.usageMonth,
          suspendedDeploymentCount,
        });
      }
    }

    return {
      thresholdAlertSent,
      monthlyCapExceeded,
      suspendedDeploymentCount,
    };
  }

  async getUsageSnapshot(orgId: string) {
    const usage = await this.getUsage(orgId);
    return {
      usageMonth: usage.usageMonth,
      usageDate: usage.usageDate,
      monthToDateCostCents: usage.monthlySpentCents,
      dayToDateCostCents: usage.dailySpentCents,
    };
  }

  async getMonthlyUsageSnapshot(orgId: string, month: string) {
    const range = getUsageMonthRange(month);
    const monthToDateCostCents = await this.sumCompletedRunCosts(orgId, range.monthStartIso, range.nextMonthStartIso);

    return {
      usageMonth: range.monthStart,
      monthToDateCostCents,
    };
  }

  private async getTierName(orgId: string): Promise<string> {
    const subscription = await getEntitlementBearingSubscription<{ tier?: string | null; status?: string | null }>(
      this.supabase,
      orgId,
    );
    return String(subscription?.tier ?? 'free').toLowerCase();
  }

  private async getUsage(orgId: string) {
    const now = this.now();
    const currentMonth = now.toISOString().slice(0, 7);
    const dayStart = startOfUtcDay(now).toISOString();
    const nextDayStart = startOfNextUtcDay(now).toISOString();

    const [monthlyUsage, dailySpentCents] = await Promise.all([
      this.getMonthlyUsageSnapshot(orgId, currentMonth),
      this.sumCompletedRunCosts(orgId, dayStart, nextDayStart),
    ]);

    return {
      usageMonth: monthlyUsage.usageMonth,
      usageDate: dayStart.slice(0, 10),
      monthlySpentCents: monthlyUsage.monthToDateCostCents,
      dailySpentCents,
    };
  }

  private async sumCompletedRunCosts(orgId: string, fromIso: string, toIso: string): Promise<number> {
    const { data, error } = await this.supabase
      .from('agent_runs')
      .select('computed_cost_cents')
      .eq('org_id', orgId)
      .in('status', ['completed', 'failed'])
      .gte('created_at', fromIso)
      .lt('created_at', toIso);

    if (error) throw error;
    return (data ?? []).reduce((sum, row) => sum + Number((row as { computed_cost_cents?: number | null }).computed_cost_cents ?? 0), 0);
  }

  private async suspendOrgDeployments(orgId: string): Promise<number> {
    const { data: activeDeployments, error: activeError } = await this.supabase
      .from('agent_deployments')
      .select('id')
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .in('status', ['DEPLOYING', 'ACTIVE']);

    if (activeError) throw activeError;
    const deploymentIds = (activeDeployments ?? []).map((deployment) => String((deployment as { id: string }).id));
    if (!deploymentIds.length) return 0;

    const { error: deploymentError } = await this.supabase
      .from('agent_deployments')
      .update({ status: 'SUSPENDED' })
      .in('id', deploymentIds);

    if (deploymentError) throw deploymentError;

    const { error: queueError } = await this.supabase
      .from('agent_runs')
      .update({
        status: 'held',
        result_summary: 'Queued run held because the monthly billing cap was exceeded',
      })
      .in('deployment_id', deploymentIds)
      .eq('status', 'queued');

    if (queueError) throw queueError;
    return deploymentIds.length;
  }

  private async sendThresholdAlert(input: {
    orgId: string;
    memoId: string;
    spentCents: number;
    capCents: number;
    thresholdPct: number;
    usageMonth: string;
  }): Promise<boolean> {
    const claimed = await this.claimAlert({
      org_id: input.orgId,
      usage_month: input.usageMonth,
      alert_type: buildThresholdAlertType(input.thresholdPct),
      threshold_pct: input.thresholdPct,
    });

    if (!claimed) return false;

    const title = `월 비용 사용량 ${input.thresholdPct}% 도달`;
    const body = `이번 달 에이전트 비용이 ${formatUsd(input.spentCents)} / ${formatUsd(input.capCents)}에 도달했습니다.`;

    await this.notifyOrgAdmins(input.orgId, title, body, input.memoId);
    await this.fireWebhooksFn(this.supabase, input.orgId, {
      event: 'billing.limit.threshold_reached',
      data: {
        org_id: input.orgId,
        memo_id: input.memoId,
        spent_cents: input.spentCents,
        monthly_cap_cents: input.capCents,
        threshold_pct: input.thresholdPct,
        usage_month: input.usageMonth,
      },
    });
    await this.sendSlackAlert(input.orgId, `:warning: ${title}\n${body}`);
    return true;
  }

  private async sendMonthlyCapExceededAlerts(input: {
    orgId: string;
    memoId: string;
    spentCents: number;
    capCents: number;
    usageMonth: string;
    suspendedDeploymentCount: number;
  }) {
    const claimed = await this.claimAlert({
      org_id: input.orgId,
      usage_month: input.usageMonth,
      alert_type: MONTHLY_LIMIT_ALERT_TYPE,
      threshold_pct: null,
    });

    if (!claimed) return;

    const title = '월 비용 한도 초과';
    const body = `이번 달 에이전트 비용이 ${formatUsd(input.spentCents)} / ${formatUsd(input.capCents)}를 넘어 조직 에이전트 ${input.suspendedDeploymentCount}개를 자동 정지했습니다.`;

    await this.notifyOrgAdmins(input.orgId, title, body, input.memoId);
    await this.sendMonthlyCapExceededEmail(input.orgId, title, body, input.memoId);
    await this.fireWebhooksFn(this.supabase, input.orgId, {
      event: 'billing.limit.monthly_cap_exceeded',
      data: {
        org_id: input.orgId,
        memo_id: input.memoId,
        spent_cents: input.spentCents,
        monthly_cap_cents: input.capCents,
        usage_month: input.usageMonth,
        suspended_deployment_count: input.suspendedDeploymentCount,
      },
    });
    await this.sendSlackAlert(input.orgId, `:no_entry: ${title}\n${body}`);
  }

  private async claimAlert(alert: AlertRow): Promise<boolean> {
    const { error } = await this.supabase
      .from('billing_limit_alerts')
      .insert(alert);

    if (!error) return true;
    if ((error as { code?: string }).code === '23505') return false;
    throw error;
  }

  private async notifyOrgAdmins(orgId: string, title: string, body: string, memoId: string) {
    const recipients = await this.listAdminRecipients(orgId);
    if (!recipients.length) return;

    const rows = recipients.map((recipient) => ({
      org_id: orgId,
      user_id: recipient.id,
      type: 'warning',
      title,
      body,
      reference_type: 'memo',
      reference_id: memoId,
    }));

    const { error } = await this.supabase.from('notifications').insert(rows);
    if (error) throw error;
  }

  private async sendMonthlyCapExceededEmail(orgId: string, title: string, body: string, memoId: string) {
    const recipients = await this.listAdminEmailRecipients(orgId);
    if (!recipients.length) return;

    const apiKey = process.env['RESEND_API_KEY'];
    const from = process.env['BILLING_ALERT_EMAIL_FROM'];
    if (!apiKey || !from) return;

    const response = await this.fetchFn(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        from,
        to: recipients.map((recipient) => recipient.email),
        subject: `[Sprintable] ${title}`,
        text: `${body}\n\nMemo: ${memoId}`,
      }),
    });

    if (!response.ok) {
      throw new Error(`billing_limit_email_failed:${response.status}`);
    }
  }

  private async listAdminRecipients(orgId: string): Promise<TeamMemberRecipientRow[]> {
    const { data: orgMembers, error: orgMembersError } = await this.supabase
      .from('org_members')
      .select('user_id')
      .eq('org_id', orgId)
      .in('role', ['owner', 'admin']);

    if (orgMembersError) throw orgMembersError;
    const userIds = (orgMembers ?? [])
      .map((row) => (row as { user_id?: string | null }).user_id ?? null)
      .filter((userId): userId is string => Boolean(userId));

    if (!userIds.length) return [];

    const { data: teamMembers, error: teamMembersError } = await this.supabase
      .from('team_members')
      .select('id, user_id')
      .eq('org_id', orgId)
      .eq('type', 'human')
      .eq('is_active', true)
      .in('user_id', userIds);

    if (teamMembersError) throw teamMembersError;
    const uniqueById = new Map<string, TeamMemberRecipientRow>();
    for (const member of teamMembers ?? []) {
      uniqueById.set(String((member as TeamMemberRecipientRow).id), member as TeamMemberRecipientRow);
    }
    return [...uniqueById.values()];
  }

  private async listAdminEmailRecipients(orgId: string): Promise<AdminAlertRecipient[]> {
    const recipients = await this.listAdminRecipients(orgId);
    if (!recipients.length) return [];

    const uniqueByEmail = new Map<string, AdminAlertRecipient>();
    await Promise.all(recipients.map(async (recipient) => {
      if (!recipient.user_id) return;
      const result = await this.supabase.auth.admin.getUserById(recipient.user_id);
      if (result.error) throw result.error;
      const email = result.data?.user?.email?.trim();
      if (!email) return;
      uniqueByEmail.set(email.toLowerCase(), {
        ...recipient,
        email,
      });
    }));

    return [...uniqueByEmail.values()];
  }

  private async sendSlackAlert(orgId: string, text: string) {
    const { data: auth, error: authError } = await this.supabase
      .from('messaging_bridge_org_auths')
      .select('access_token_ref, expires_at')
      .eq('org_id', orgId)
      .eq('platform', 'slack')
      .maybeSingle();

    if (authError) throw authError;
    const slackAuth = (auth as SlackAuthRow | null) ?? null;
    if (!slackAuth) return;

    const token = resolveMessagingBridgeSecretRef(slackAuth.access_token_ref);
    if (!token || isExpiredIsoTimestamp(slackAuth.expires_at, this.now().getTime())) return;

    const { data: channels, error: channelsError } = await this.supabase
      .from('messaging_bridge_channels')
      .select('channel_id')
      .eq('org_id', orgId)
      .eq('platform', 'slack')
      .eq('is_active', true);

    if (channelsError) throw channelsError;
    const channelIds = [...new Set((channels ?? []).map((channel) => String((channel as SlackChannelRow).channel_id)).filter(Boolean))];
    if (!channelIds.length) return;

    await Promise.allSettled(channelIds.map(async (channelId) => {
      await this.fetchFn('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: channelId,
          text,
        }),
      });
    }));
  }
}

export function createBlockedBillingPatch(code: 'daily_cap_exceeded' | 'monthly_cap_exceeded', reason: string) {
  const errorCode = code === 'daily_cap_exceeded' ? DAILY_LIMIT_ERROR_CODE : MONTHLY_LIMIT_ERROR_CODE;
  return {
    status: 'failed' as const,
    finished_at: new Date().toISOString(),
    llm_call_count: 0,
    tool_call_history: [],
    output_memo_ids: [],
    last_error_code: errorCode,
    error_message: reason,
    result_summary: reason,
    failure_disposition: 'non_retryable' as const,
    duration_ms: 0,
    model: null,
    input_tokens: null,
    output_tokens: null,
    cost_usd: 0,
    computed_cost_cents: 0,
    llm_provider: null,
    llm_provider_key: null,
    per_run_cap_cents: null,
    billing_notes: [errorCode],
  };
}
