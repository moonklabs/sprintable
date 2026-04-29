import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient, getMyTeamMember, requireOrgAdmin, getResolvedSettings, getUsageSnapshot, saveSettings } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
  getResolvedSettings: vi.fn(),
  getUsageSnapshot: vi.fn(),
  saveSettings: vi.fn(),
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
    getUsageSnapshot = getUsageSnapshot;
    saveSettings = saveSettings;
  },
}));

import { GET, PUT } from './route';

describe('billing limits route', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    getResolvedSettings.mockReset();
    getUsageSnapshot.mockReset();
    saveSettings.mockReset();

    createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
      },
    });
    getMyTeamMember.mockResolvedValue({ id: 'tm-1', org_id: 'org-1', project_id: 'project-1' });
    requireOrgAdmin.mockResolvedValue(undefined);
  });

  it('returns resolved billing limits for the current org', async () => {
    getResolvedSettings.mockResolvedValue({
      monthlyCapCents: 1000,
      dailyCapCents: null,
      alertThresholdPct: 80,
      source: 'plan_default',
      tierName: 'free',
    });
    getUsageSnapshot.mockResolvedValue({
      usageMonth: '2026-04-01',
      usageDate: '2026-04-07',
      monthToDateCostCents: 420,
      dayToDateCostCents: 42,
    });

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      org_id: 'org-1',
      monthly_cap_cents: 1000,
      monthly_cap_unlimited: false,
      source: 'plan_default',
      tier_name: 'free',
      month_to_date_cost_cents: 420,
      day_to_date_cost_cents: 42,
    });
  });

  it('rejects negative limits with 400 validation failure', async () => {
    const response = await PUT(new Request('http://localhost/api/v1/billing/limits', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monthly_cap_cents: -1, daily_cap_cents: 50, alert_threshold_pct: 80 }),
    }));

    expect(response.status).toBe(400);
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
