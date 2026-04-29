import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient, getMyTeamMember, requireOrgAdmin, loadMonthlyAgentUsageRows, ensureUsageProjectInOrg } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
  loadMonthlyAgentUsageRows: vi.fn(),
  ensureUsageProjectInOrg: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return { ...actual, getMyTeamMember };
});
vi.mock('@/lib/admin-check', () => ({ requireOrgAdmin }));
vi.mock('@/services/monthly-agent-usage-dashboard', () => ({
  loadMonthlyAgentUsageRows,
  ensureUsageProjectInOrg,
}));

import { GET } from './route';

function createSupabaseStub() {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
  };
}

describe('GET /api/v1/billing/agent-usage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-07T10:00:00Z'));
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    loadMonthlyAgentUsageRows.mockReset();
    ensureUsageProjectInOrg.mockReset();
    getMyTeamMember.mockResolvedValue({ id: 'tm-1', org_id: 'org-1', project_id: 'project-1' });
    requireOrgAdmin.mockResolvedValue(undefined);
    ensureUsageProjectInOrg.mockResolvedValue(null);
  });

  it('returns monthly usage totals for the requested org and month', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    loadMonthlyAgentUsageRows.mockResolvedValue([
      { project_id: 'project-1', agent_id: 'agent-1', model: 'gpt-4o-mini', duration_ms: 3600000, input_tokens: 10000, output_tokens: 1000, computed_cost_cents: 3456 },
      { project_id: 'project-1', agent_id: 'agent-2', model: 'gpt-4o', duration_ms: 9000000, input_tokens: 1200, output_tokens: 145, computed_cost_cents: 3333 },
    ]);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage?org_id=org-1&month=2026-04'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      org_id: 'org-1',
      month: '2026-04',
      project_id: null,
      project_name: null,
      active_agents: 2,
      total_hours: 3.5,
      total_tokens: 12345,
      total_cost_cents: 6789,
    });
    expect(loadMonthlyAgentUsageRows).toHaveBeenCalledWith(supabase, {
      orgId: 'org-1',
      month: '2026-04',
      projectId: null,
    });
  });

  it('returns zero values instead of 404 when the month has no runs', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    loadMonthlyAgentUsageRows.mockResolvedValue([]);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage?org_id=org-1&month=2026-04'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      active_agents: 0,
      total_hours: 0,
      total_tokens: 0,
      total_cost_cents: 0,
    });
  });

  it('supports project-scoped summaries', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    ensureUsageProjectInOrg.mockResolvedValue({ id: 'project-1', name: 'Apollo' });
    loadMonthlyAgentUsageRows.mockResolvedValue([
      { project_id: 'project-1', agent_id: 'agent-1', model: 'gpt-4o-mini', duration_ms: 1800000, input_tokens: 100, output_tokens: 20, computed_cost_cents: 300 },
    ]);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage?org_id=org-1&month=2026-04&project_id=project-1'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      project_id: 'project-1',
      project_name: 'Apollo',
      total_cost_cents: 300,
    });
  });

  it('rejects cross-org usage lookups', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage?org_id=org-2&month=2026-04'));
    expect(response.status).toBe(403);
    expect(loadMonthlyAgentUsageRows).not.toHaveBeenCalled();
  });

  it('rejects invalid month formats', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage?org_id=org-1&month=2026/04'));
    expect(response.status).toBe(400);
  });

  it('rejects future months', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage?org_id=org-1&month=2026-05'));
    expect(response.status).toBe(400);
  });
});
