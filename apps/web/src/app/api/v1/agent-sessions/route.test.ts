import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  createSupabaseServerClientMock,
  getMyTeamMemberMock,
  requireOrgAdminMock,
  requireAgentOrchestrationMock,
  listSessionsMock,
} = vi.hoisted(() => ({
  createSupabaseServerClientMock: vi.fn(),
  getMyTeamMemberMock: vi.fn(),
  requireOrgAdminMock: vi.fn(),
  requireAgentOrchestrationMock: vi.fn(),
  listSessionsMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: createSupabaseServerClientMock,
}));

vi.mock('@/lib/auth-helpers', () => ({
  getMyTeamMember: getMyTeamMemberMock,
}));

vi.mock('@/lib/admin-check', () => ({
  requireOrgAdmin: requireOrgAdminMock,
}));

vi.mock('@/lib/require-agent-orchestration', () => ({
  requireAgentOrchestration: requireAgentOrchestrationMock,
}));

vi.mock('@/services/agent-session-lifecycle', () => ({
  AgentSessionLifecycleService: class {
    listSessions = listSessionsMock;
  },
}));

import { GET } from './route';

describe('GET /api/v1/agent-sessions', () => {
  beforeEach(() => {
    createSupabaseServerClientMock.mockReset();
    getMyTeamMemberMock.mockReset();
    requireOrgAdminMock.mockReset();
    requireAgentOrchestrationMock.mockReset();
    listSessionsMock.mockReset();

    createSupabaseServerClientMock.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
    });
    getMyTeamMemberMock.mockResolvedValue({ id: 'member-1', org_id: 'org-1', project_id: 'project-1' });
    requireOrgAdminMock.mockResolvedValue(undefined);
    requireAgentOrchestrationMock.mockResolvedValue(null);
    listSessionsMock.mockResolvedValue([{ id: 'session-1', status: 'active' }]);
  });

  it('blocks session reads when upgrade is required', async () => {
    requireAgentOrchestrationMock.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await GET(new Request('http://localhost:3000/api/v1/agent-sessions?status=active&limit=5'));

    expect(response.status).toBe(403);
    expect(listSessionsMock).not.toHaveBeenCalled();
  });

  it('lists project sessions for org admins', async () => {
    const response = await GET(new Request('http://localhost:3000/api/v1/agent-sessions?status=active&limit=5'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(requireAgentOrchestrationMock).toHaveBeenCalledWith(expect.anything(), 'org-1');
    expect(listSessionsMock).toHaveBeenCalledWith({
      orgId: 'org-1',
      projectId: 'project-1',
      agentId: undefined,
      status: 'active',
      limit: 5,
    });
    expect(payload.data.sessions).toEqual([{ id: 'session-1', status: 'active' }]);
  });
});
