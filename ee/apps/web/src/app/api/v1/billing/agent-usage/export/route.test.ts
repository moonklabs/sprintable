import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSupabaseServerClient,
  getMyTeamMember,
  requireOrgAdmin,
  loadMonthlyAgentUsageRows,
  loadMonthlyUsageLookupMaps,
  ensureUsageProjectInOrg,
} = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
  loadMonthlyAgentUsageRows: vi.fn(),
  loadMonthlyUsageLookupMaps: vi.fn(),
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
  loadMonthlyUsageLookupMaps,
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

describe('GET /api/v1/billing/agent-usage/export', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-12T08:00:00Z'));
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    loadMonthlyAgentUsageRows.mockReset();
    loadMonthlyUsageLookupMaps.mockReset();
    ensureUsageProjectInOrg.mockReset();
    getMyTeamMember.mockResolvedValue({ id: 'tm-1', org_id: 'org-1' });
    requireOrgAdmin.mockResolvedValue(undefined);
    ensureUsageProjectInOrg.mockResolvedValue(null);
    loadMonthlyUsageLookupMaps.mockResolvedValue({
      projectNameById: { 'project-1': 'Apollo' },
      agentNameById: { 'agent-1': 'Sentinel' },
    });
  });

  it('exports the selected breakdown as csv', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    loadMonthlyAgentUsageRows.mockResolvedValue([
      { project_id: 'project-1', agent_id: 'agent-1', model: 'gpt-4o-mini', duration_ms: 3600000, input_tokens: 100, output_tokens: 20, computed_cost_cents: 300 },
    ]);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage/export?month=2026-04&group_by=project'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/csv');
    expect(response.headers.get('Content-Disposition')).toContain('agent-usage-2026-04-project.csv');
    const csv = await response.text();
    expect(csv).toContain('month,2026-04');
    expect(csv).toContain('project,All projects');
    expect(csv).toContain('project-1,Apollo,1,120,300,1');
  });

  it('supports project-scoped exports', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    ensureUsageProjectInOrg.mockResolvedValue({ id: 'project-1', name: 'Apollo' });
    loadMonthlyAgentUsageRows.mockResolvedValue([]);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage/export?month=2026-04&group_by=agent&project_id=project-1'));

    expect(response.status).toBe(200);
    const csv = await response.text();
    expect(csv).toContain('project,Apollo');
  });

  it('rejects invalid breakdown group values', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage/export?month=2026-04&group_by=team'));

    expect(response.status).toBe(400);
  });
});
