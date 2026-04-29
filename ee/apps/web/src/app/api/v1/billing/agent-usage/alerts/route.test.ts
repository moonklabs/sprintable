import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSupabaseServerClient,
  getMyTeamMember,
  requireOrgAdmin,
  getResolvedSettings,
  getMonthlyUsageSnapshot,
  listMonthlyBillingLimitAlerts,
} = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
  getResolvedSettings: vi.fn(),
  getMonthlyUsageSnapshot: vi.fn(),
  listMonthlyBillingLimitAlerts: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return { ...actual, getMyTeamMember };
});
vi.mock('@/lib/admin-check', () => ({ requireOrgAdmin }));
vi.mock('@/services/billing-limit-enforcer', () => ({
  BillingLimitEnforcer: class {
    getResolvedSettings = getResolvedSettings;
    getMonthlyUsageSnapshot = getMonthlyUsageSnapshot;
  },
}));
vi.mock('@/services/monthly-agent-usage-dashboard', () => ({
  listMonthlyBillingLimitAlerts,
}));

import { GET } from './route';

function createSupabaseStub() {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
  };
}

describe('GET /api/v1/billing/agent-usage/alerts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T08:00:00Z'));
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    getResolvedSettings.mockReset();
    getMonthlyUsageSnapshot.mockReset();
    listMonthlyBillingLimitAlerts.mockReset();
    getMyTeamMember.mockResolvedValue({ id: 'tm-1', org_id: 'org-1' });
    requireOrgAdmin.mockResolvedValue(undefined);
  });

  it('returns alert summary and recent alert records', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    getResolvedSettings.mockResolvedValue({
      monthlyCapCents: 10000,
      dailyCapCents: null,
      alertThresholdPct: 80,
      source: 'explicit',
      tierName: 'pro',
    });
    getMonthlyUsageSnapshot.mockResolvedValue({
      usageMonth: '2026-04-01',
      monthToDateCostCents: 8100,
    });
    listMonthlyBillingLimitAlerts.mockResolvedValue([
      {
        alert_type: 'threshold_80',
        threshold_pct: 80,
        usage_month: '2026-04-01',
        created_at: '2026-04-12T07:00:00.000Z',
      },
    ]);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage/alerts?month=2026-04'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      org_id: 'org-1',
      usage_month: '2026-04-01',
      scope_type: 'org',
      scope_label: 'Organization-wide budget alerts',
      project_filter_applies: false,
      month_to_date_cost_cents: 8100,
      monthly_cap_cents: 10000,
      threshold_amount_cents: 8000,
      threshold_reached: true,
      monthly_cap_exceeded: false,
    });
    expect(body.data.alerts).toEqual([
      expect.objectContaining({
        alert_type: 'threshold_80',
        kind: 'threshold',
        label: '80% threshold reached',
      }),
    ]);
    expect(getMonthlyUsageSnapshot).toHaveBeenCalledWith('org-1', '2026-04');
    expect(listMonthlyBillingLimitAlerts).toHaveBeenCalledWith(supabase, {
      orgId: 'org-1',
      usageMonth: '2026-04-01',
    });
  });

  it('keeps the alert month basis aligned with the billing ledger snapshot', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    getResolvedSettings.mockResolvedValue({
      monthlyCapCents: 10000,
      dailyCapCents: null,
      alertThresholdPct: 80,
      source: 'explicit',
      tierName: 'pro',
    });
    getMonthlyUsageSnapshot.mockResolvedValue({
      usageMonth: '2026-04-01',
      monthToDateCostCents: 0,
    });
    listMonthlyBillingLimitAlerts.mockResolvedValue([]);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage/alerts?month=2026-04'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      usage_month: '2026-04-01',
      month_to_date_cost_cents: 0,
      threshold_reached: false,
      monthly_cap_exceeded: false,
    });
  });

  it('rejects invalid month formats', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage/alerts?month=2026/04'));

    expect(response.status).toBe(400);
  });
});
