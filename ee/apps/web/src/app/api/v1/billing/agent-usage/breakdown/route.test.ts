import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient, getMyTeamMember, requireOrgAdmin, loadMonthlyAgentUsageRows, loadMonthlyUsageLookupMaps, ensureUsageProjectInOrg } = vi.hoisted(() => ({
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

describe('GET /api/v1/billing/agent-usage/breakdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-07T10:00:00Z'));
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    loadMonthlyAgentUsageRows.mockReset();
    loadMonthlyUsageLookupMaps.mockReset();
    ensureUsageProjectInOrg.mockReset();
    getMyTeamMember.mockResolvedValue({ id: 'tm-1', org_id: 'org-1', project_id: 'project-1' });
    requireOrgAdmin.mockResolvedValue(undefined);
    ensureUsageProjectInOrg.mockResolvedValue(null);
    loadMonthlyUsageLookupMaps.mockResolvedValue({
      projectNameById: { 'project-1': 'Apollo' },
      agentNameById: { 'agent-1': 'Sentinel' },
    });
  });

  it('returns agent-level breakdown rows', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    loadMonthlyAgentUsageRows.mockResolvedValue([
      { project_id: 'project-1', agent_id: 'agent-1', model: 'gpt-4o-mini', duration_ms: 37800000, input_tokens: 10000, output_tokens: 5000, computed_cost_cents: 2300 },
    ]);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage/breakdown?org_id=org-1&month=2026-04&group_by=agent'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.rows).toEqual([
      expect.objectContaining({ key: 'agent-1', label: 'Sentinel', total_hours: 10.5, total_tokens: 15000, total_cost_cents: 2300, run_count: 1 }),
    ]);
  });

  it('returns model-level breakdown rows', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    loadMonthlyAgentUsageRows.mockResolvedValue([
      { project_id: 'project-1', agent_id: 'agent-1', model: 'gpt-4o-mini', duration_ms: 29520000, input_tokens: 7000, output_tokens: 2000, computed_cost_cents: 1200 },
    ]);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage/breakdown?org_id=org-1&month=2026-04&group_by=model'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.rows[0]).toMatchObject({ key: 'gpt-4o-mini', label: 'gpt-4o-mini' });
  });

  it('returns project-level breakdown rows when all projects are selected', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    loadMonthlyAgentUsageRows.mockResolvedValue([
      { project_id: 'project-1', agent_id: 'agent-1', model: 'gpt-4o-mini', duration_ms: 3600000, input_tokens: 100, output_tokens: 20, computed_cost_cents: 300 },
    ]);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage/breakdown?org_id=org-1&month=2026-04&group_by=project'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.rows[0]).toMatchObject({ key: 'project-1', label: 'Apollo', total_cost_cents: 300 });
  });

  it('rejects invalid breakdown group values', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage/breakdown?org_id=org-1&month=2026-04&group_by=team'));
    expect(response.status).toBe(400);
  });

  it('rejects cross-org breakdown lookups', async () => {
    const supabase = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await GET(new Request('http://localhost/api/v1/billing/agent-usage/breakdown?org_id=org-2&month=2026-04&group_by=agent'));
    expect(response.status).toBe(403);
    expect(loadMonthlyAgentUsageRows).not.toHaveBeenCalled();
  });
});
