import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingLimitEnforcer } from './billing-limit-enforcer';

interface RunRow {
  id: string;
  org_id: string;
  deployment_id: string | null;
  status: string;
  created_at: string;
  computed_cost_cents: number;
  result_summary?: string | null;
}

interface DeploymentRow {
  id: string;
  org_id: string;
  status: string;
  deleted_at: string | null;
}

function createSupabaseStub(options?: {
  billingLimits?: { monthly_cap_cents: number | null; daily_cap_cents: number | null; alert_threshold_pct: number | null } | null;
  subscriptions?: Array<{ org_id: string; status: string; tier_id: string }>;
  planTiers?: Array<{ id: string; name: string }>;
  runs?: RunRow[];
  deployments?: DeploymentRow[];
  orgMembers?: Array<{ org_id: string; user_id: string; role: string }>;
  teamMembers?: Array<{ id: string; org_id: string; user_id: string | null; type: string; is_active: boolean }>;
  slackAuth?: { access_token_ref: string; expires_at: string | null } | null;
  slackChannels?: Array<{ org_id: string; channel_id: string; platform: string; is_active: boolean }>;
}) {
  const state = {
    billingLimits: options?.billingLimits ? { org_id: 'org-1', ...options.billingLimits } : null,
    subscriptions: options?.subscriptions ?? [],
    planTiers: options?.planTiers ?? [{ id: 'tier-free', name: 'free' }],
    runs: options?.runs ?? [],
    deployments: options?.deployments ?? [],
    orgMembers: options?.orgMembers ?? [{ org_id: 'org-1', user_id: 'user-admin', role: 'owner' }],
    teamMembers: options?.teamMembers ?? [{ id: 'tm-admin', org_id: 'org-1', user_id: 'user-admin', type: 'human', is_active: true }],
    alerts: [] as Array<{ org_id: string; usage_month: string; alert_type: string; threshold_pct: number | null }>,
    notifications: [] as Array<Record<string, unknown>>,
    memoReplies: [] as Array<Record<string, unknown>>,
    slackAuth: options?.slackAuth ? { org_id: 'org-1', platform: 'slack', ...options.slackAuth } : null,
    slackChannels: options?.slackChannels ?? [],
  };

  function applyFilters<T extends Record<string, unknown>>(rows: T[], filters: Array<{ kind: 'eq' | 'in' | 'gte' | 'lt' | 'is'; column: string; value: unknown }>) {
    return rows.filter((row) => filters.every((filter) => {
      const value = row[filter.column];
      if (filter.kind === 'eq') return value === filter.value;
      if (filter.kind === 'is') return filter.value === null ? value == null : value === filter.value;
      if (filter.kind === 'in') return Array.isArray(filter.value) && filter.value.includes(value);
      if (filter.kind === 'gte') return String(value ?? '') >= String(filter.value);
      if (filter.kind === 'lt') return String(value ?? '') < String(filter.value);
      return true;
    }));
  }

  function createSelectBuilder<T extends Record<string, unknown>>(rowsFactory: () => T[]) {
    const filters: Array<{ kind: 'eq' | 'in' | 'gte' | 'lt' | 'is'; column: string; value: unknown }> = [];
    const builder = {
      select() { return builder; },
      eq(column: string, value: unknown) { filters.push({ kind: 'eq', column, value }); return builder; },
      in(column: string, value: unknown[]) { filters.push({ kind: 'in', column, value }); return builder; },
      gte(column: string, value: unknown) { filters.push({ kind: 'gte', column, value }); return builder; },
      lt(column: string, value: unknown) { filters.push({ kind: 'lt', column, value }); return builder; },
      is(column: string, value: unknown) { filters.push({ kind: 'is', column, value }); return builder; },
      maybeSingle: async () => {
        const rows = applyFilters(rowsFactory(), filters);
        return { data: rows[0] ?? null, error: null };
      },
      then(resolve: (value: { data: T[]; error: null }) => unknown) {
        const rows = applyFilters(rowsFactory(), filters);
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      },
    };
    return builder;
  }

  const supabase = {
    auth: {
      admin: {
        getUserById: vi.fn(async (userId: string) => ({
          data: {
            user: {
              id: userId,
              email: userId === 'user-admin' ? 'admin@sprintable.test' : `${userId}@example.test`,
            },
          },
          error: null,
        })),
      },
    },
    from(table: string) {
      if (table === 'billing_limits') {
        return {
          ...createSelectBuilder(() => state.billingLimits ? [state.billingLimits] : []),
          upsert: async (payload: Record<string, unknown>) => {
            state.billingLimits = {
              org_id: 'org-1',
              monthly_cap_cents: (payload.monthly_cap_cents as number | null | undefined) ?? null,
              daily_cap_cents: (payload.daily_cap_cents as number | null | undefined) ?? null,
              alert_threshold_pct: (payload.alert_threshold_pct as number | null | undefined) ?? 80,
            };
            return { error: null };
          },
        };
      }

      if (table === 'subscriptions') {
        return createSelectBuilder(() => state.subscriptions as Array<Record<string, unknown>>);
      }

      if (table === 'plan_tiers') {
        return createSelectBuilder(() => state.planTiers as Array<Record<string, unknown>>);
      }

      if (table === 'agent_runs') {
        const filters: Array<{ kind: 'eq' | 'in' | 'gte' | 'lt' | 'is'; column: string; value: unknown }> = [];
        let updatePayload: Record<string, unknown> | null = null;
        const builder = {
          select() { return builder; },
          update(payload: Record<string, unknown>) { updatePayload = payload; return builder; },
          eq(column: string, value: unknown) { filters.push({ kind: 'eq', column, value }); return builder; },
          in(column: string, value: unknown[]) { filters.push({ kind: 'in', column, value }); return builder; },
          gte(column: string, value: unknown) { filters.push({ kind: 'gte', column, value }); return builder; },
          lt(column: string, value: unknown) { filters.push({ kind: 'lt', column, value }); return builder; },
          is(column: string, value: unknown) { filters.push({ kind: 'is', column, value }); return builder; },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            const rows = applyFilters(state.runs as unknown as Array<Record<string, unknown>>, filters);
            if (updatePayload) {
              rows.forEach((row) => Object.assign(row, updatePayload));
              return Promise.resolve({ data: rows, error: null }).then(resolve);
            }
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
        };
        return builder;
      }

      if (table === 'agent_deployments') {
        const filters: Array<{ kind: 'eq' | 'in' | 'gte' | 'lt' | 'is'; column: string; value: unknown }> = [];
        let updatePayload: Record<string, unknown> | null = null;
        const builder = {
          select() { return builder; },
          update(payload: Record<string, unknown>) { updatePayload = payload; return builder; },
          eq(column: string, value: unknown) { filters.push({ kind: 'eq', column, value }); return builder; },
          in(column: string, value: unknown[]) { filters.push({ kind: 'in', column, value }); return builder; },
          is(column: string, value: unknown) { filters.push({ kind: 'is', column, value }); return builder; },
          then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
            const rows = applyFilters(state.deployments as unknown as Array<Record<string, unknown>>, filters);
            if (updatePayload) {
              rows.forEach((row) => Object.assign(row, updatePayload));
              return Promise.resolve({ data: rows, error: null }).then(resolve);
            }
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          },
        };
        return builder;
      }

      if (table === 'billing_limit_alerts') {
        return {
          insert: async (payload: Record<string, unknown>) => {
            const key = `${payload.org_id}:${payload.usage_month}:${payload.alert_type}`;
            const exists = state.alerts.some((row) => `${row.org_id}:${row.usage_month}:${row.alert_type}` === key);
            if (exists) {
              return { error: { code: '23505', message: 'duplicate key' } };
            }
            state.alerts.push(payload as never);
            return { error: null };
          },
        };
      }

      if (table === 'memo_replies') {
        return {
          insert: async (payload: Record<string, unknown>) => {
            state.memoReplies.push(payload);
            return { error: null };
          },
        };
      }

      if (table === 'org_members') {
        return createSelectBuilder(() => state.orgMembers as Array<Record<string, unknown>>);
      }

      if (table === 'team_members') {
        return createSelectBuilder(() => state.teamMembers as Array<Record<string, unknown>>);
      }

      if (table === 'notifications') {
        return {
          insert: async (payload: Record<string, unknown> | Array<Record<string, unknown>>) => {
            state.notifications.push(...(Array.isArray(payload) ? payload : [payload]));
            return { error: null };
          },
        };
      }

      if (table === 'messaging_bridge_org_auths') {
        return createSelectBuilder(() => state.slackAuth ? [state.slackAuth as Record<string, unknown>] : []);
      }

      if (table === 'messaging_bridge_channels') {
        return createSelectBuilder(() => state.slackChannels as Array<Record<string, unknown>>);
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };

  return { supabase, state };
}

describe('BillingLimitEnforcer', () => {
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.BILLING_ALERT_EMAIL_FROM;
  });

  it('returns the free-plan default monthly cap when explicit settings are missing', async () => {
    const { supabase } = createSupabaseStub();
    const enforcer = new BillingLimitEnforcer(supabase as never, {
      fireWebhooksFn: vi.fn(),
      now: () => new Date('2026-04-07T12:00:00.000Z'),
    });

    const settings = await enforcer.getResolvedSettings('org-1');

    expect(settings).toMatchObject({
      monthlyCapCents: 1000,
      dailyCapCents: null,
      alertThresholdPct: 80,
      source: 'plan_default',
      tierName: 'free',
    });
  });

  it('keeps monthly usage snapshots on created_at month boundaries', async () => {
    const { supabase } = createSupabaseStub({
      runs: [{
        id: 'run-cross-month',
        org_id: 'org-1',
        deployment_id: 'deployment-1',
        status: 'completed',
        created_at: '2026-03-31T23:50:00.000Z',
        computed_cost_cents: 900,
      }],
    });
    const enforcer = new BillingLimitEnforcer(supabase as never, {
      fireWebhooksFn: vi.fn(),
      now: () => new Date('2026-04-12T12:00:00.000Z'),
    });

    const march = await enforcer.getMonthlyUsageSnapshot('org-1', '2026-03');
    const april = await enforcer.getMonthlyUsageSnapshot('org-1', '2026-04');

    expect(march).toEqual({ usageMonth: '2026-03-01', monthToDateCostCents: 900 });
    expect(april).toEqual({ usageMonth: '2026-04-01', monthToDateCostCents: 0 });
  });

  it('ignores running and hitl_pending runs in monthly usage snapshots', async () => {
    const { supabase } = createSupabaseStub({
      runs: [{
        id: 'run-completed',
        org_id: 'org-1',
        deployment_id: 'deployment-1',
        status: 'completed',
        created_at: '2026-04-07T03:00:00.000Z',
        computed_cost_cents: 700,
      }, {
        id: 'run-running',
        org_id: 'org-1',
        deployment_id: 'deployment-1',
        status: 'running',
        created_at: '2026-04-07T04:00:00.000Z',
        computed_cost_cents: 500,
      }, {
        id: 'run-hitl',
        org_id: 'org-1',
        deployment_id: 'deployment-1',
        status: 'hitl_pending',
        created_at: '2026-04-07T05:00:00.000Z',
        computed_cost_cents: 400,
      }],
    });
    const enforcer = new BillingLimitEnforcer(supabase as never, {
      fireWebhooksFn: vi.fn(),
      now: () => new Date('2026-04-12T12:00:00.000Z'),
    });

    const usage = await enforcer.getMonthlyUsageSnapshot('org-1', '2026-04');

    expect(usage).toEqual({ usageMonth: '2026-04-01', monthToDateCostCents: 700 });
  });

  it('drops same-day execution and leaves a memo reply when the daily cap is already consumed', async () => {
    const { supabase, state } = createSupabaseStub({
      billingLimits: { monthly_cap_cents: 2000, daily_cap_cents: 100, alert_threshold_pct: 80 },
      runs: [{
        id: 'run-1',
        org_id: 'org-1',
        deployment_id: 'deployment-1',
        status: 'completed',
        created_at: '2026-04-07T03:00:00.000Z',
        computed_cost_cents: 100,
      }],
    });
    const enforcer = new BillingLimitEnforcer(supabase as never, {
      fireWebhooksFn: vi.fn(),
      now: () => new Date('2026-04-07T12:00:00.000Z'),
    });

    const result = await enforcer.enforceBeforeRun({
      run: { id: 'run-2', org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-1', memo_id: 'memo-1' },
      memo: { id: 'memo-1', title: 'Daily billing check' },
    });

    expect(result.status).toBe('daily_cap_exceeded');
    expect(state.memoReplies).toContainEqual(expect.objectContaining({
      memo_id: 'memo-1',
      created_by: 'agent-1',
      content: '일일 한도 초과, 내일 재개',
    }));
  });

  it('sends the threshold alert only once per month', async () => {
    const fireWebhooksFn = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) } as Response));
    const { supabase, state } = createSupabaseStub({
      billingLimits: { monthly_cap_cents: 1000, daily_cap_cents: null, alert_threshold_pct: 80 },
      runs: [{
        id: 'run-1',
        org_id: 'org-1',
        deployment_id: 'deployment-1',
        status: 'completed',
        created_at: '2026-04-07T03:00:00.000Z',
        computed_cost_cents: 850,
      }],
      slackAuth: { access_token_ref: 'xoxb-test-token', expires_at: null },
      slackChannels: [{ org_id: 'org-1', channel_id: 'C123', platform: 'slack', is_active: true }],
    });
    const enforcer = new BillingLimitEnforcer(supabase as never, {
      fireWebhooksFn,
      fetchFn,
      now: () => new Date('2026-04-07T12:00:00.000Z'),
    });

    const first = await enforcer.enforceAfterRun({
      run: { id: 'run-1', org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-1', memo_id: 'memo-1' },
      memo: { id: 'memo-1', title: 'Threshold' },
    });
    const second = await enforcer.enforceAfterRun({
      run: { id: 'run-1', org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-1', memo_id: 'memo-1' },
      memo: { id: 'memo-1', title: 'Threshold' },
    });

    expect(first.thresholdAlertSent).toBe(true);
    expect(second.thresholdAlertSent).toBe(false);
    expect(state.alerts).toHaveLength(1);
    expect(state.notifications).toHaveLength(1);
    expect(fireWebhooksFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('suspends live deployments when the monthly cap is exceeded and sends admin email alerts', async () => {
    process.env.RESEND_API_KEY = 'resend-test-key';
    process.env.BILLING_ALERT_EMAIL_FROM = 'alerts@sprintable.test';
    const fireWebhooksFn = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ id: 'email-1' }) } as Response));
    const { supabase, state } = createSupabaseStub({
      billingLimits: { monthly_cap_cents: 1000, daily_cap_cents: null, alert_threshold_pct: 80 },
      runs: [{
        id: 'run-1',
        org_id: 'org-1',
        deployment_id: 'deployment-1',
        status: 'completed',
        created_at: '2026-04-07T03:00:00.000Z',
        computed_cost_cents: 1201,
      }, {
        id: 'run-queued',
        org_id: 'org-1',
        deployment_id: 'deployment-1',
        status: 'queued',
        created_at: '2026-04-07T04:00:00.000Z',
        computed_cost_cents: 0,
      }],
      deployments: [
        { id: 'deployment-1', org_id: 'org-1', status: 'ACTIVE', deleted_at: null },
        { id: 'deployment-2', org_id: 'org-1', status: 'DEPLOYING', deleted_at: null },
        { id: 'deployment-3', org_id: 'org-1', status: 'SUSPENDED', deleted_at: null },
      ],
    });
    const enforcer = new BillingLimitEnforcer(supabase as never, {
      fireWebhooksFn,
      fetchFn,
      now: () => new Date('2026-04-07T12:00:00.000Z'),
    });

    const result = await enforcer.enforceAfterRun({
      run: { id: 'run-1', org_id: 'org-1', project_id: 'project-1', agent_id: 'agent-1', memo_id: 'memo-1' },
      memo: { id: 'memo-1', title: 'Monthly cap' },
    });

    expect(result.monthlyCapExceeded).toBe(true);
    expect(result.suspendedDeploymentCount).toBe(2);
    expect(state.deployments.filter((row) => ['deployment-1', 'deployment-2'].includes(row.id)).every((row) => row.status === 'SUSPENDED')).toBe(true);
    expect(state.runs.find((row) => row.id === 'run-queued')?.status).toBe('held');
    expect(fireWebhooksFn).toHaveBeenCalledWith(expect.anything(), 'org-1', expect.objectContaining({ event: 'billing.limit.monthly_cap_exceeded' }));
    expect(fetchFn).toHaveBeenCalledWith('https://api.resend.com/emails', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer resend-test-key' }),
    }));
  });
});
