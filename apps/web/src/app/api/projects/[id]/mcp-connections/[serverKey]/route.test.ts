import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSupabaseServerClientMock,
  createSupabaseAdminClientMock,
  getMyTeamMemberMock,
  requireOrgAdminMock,
  upsertProjectMcpConnectionMock,
  deleteProjectMcpConnectionMock,
  transitionDeploymentMock,
} = vi.hoisted(() => ({
  createSupabaseServerClientMock: vi.fn(),
  createSupabaseAdminClientMock: vi.fn(() => ({ tag: 'admin' })),
  getMyTeamMemberMock: vi.fn(),
  requireOrgAdminMock: vi.fn(),
  upsertProjectMcpConnectionMock: vi.fn(),
  deleteProjectMcpConnectionMock: vi.fn(),
  transitionDeploymentMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: createSupabaseServerClientMock,
}));

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: createSupabaseAdminClientMock,
}));

vi.mock('@/lib/auth-helpers', () => ({
  getMyTeamMember: getMyTeamMemberMock,
}));

vi.mock('@/lib/admin-check', () => ({
  requireOrgAdmin: requireOrgAdminMock,
}));

vi.mock('@/services/project-mcp', () => ({
  upsertProjectMcpConnection: upsertProjectMcpConnectionMock,
  deleteProjectMcpConnection: deleteProjectMcpConnectionMock,
}));

vi.mock('@/services/agent-deployment-lifecycle', () => ({
  AgentDeploymentLifecycleService: class {
    transitionDeployment = transitionDeploymentMock;
  },
}));

import { DELETE, PUT } from './route';

function createSupabaseStub() {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })),
    },
    from(table: string) {
      if (table !== 'agent_deployments') {
        throw new Error(`Unexpected table: ${table}`);
      }
      return {
        select() { return this; },
        eq() { return this; },
        in: async () => ({
          data: [{ id: 'deployment-1', status: 'ACTIVE' }],
          error: null,
        }),
      };
    },
  };
}

describe('project mcp connection detail route', () => {
  beforeEach(() => {
    createSupabaseServerClientMock.mockReset();
    createSupabaseAdminClientMock.mockClear();
    getMyTeamMemberMock.mockReset();
    requireOrgAdminMock.mockReset();
    upsertProjectMcpConnectionMock.mockReset();
    deleteProjectMcpConnectionMock.mockReset();
    transitionDeploymentMock.mockReset();

    createSupabaseServerClientMock.mockResolvedValue(createSupabaseStub());
    getMyTeamMemberMock.mockResolvedValue({ id: 'member-1', org_id: 'org-1', project_id: 'project-1' });
    requireOrgAdminMock.mockResolvedValue(undefined);
  });

  it('connects a manual MCP credential', async () => {
    upsertProjectMcpConnectionMock.mockResolvedValue({ serverKey: 'linear', displayName: 'Linear' });

    const response = await PUT(new Request('https://sprintable.app/api/projects/project-1/mcp-connections/linear', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'lin_api_key', label: 'Moonklabs Linear' }),
    }), {
      params: Promise.resolve({ id: 'project-1', serverKey: 'linear' }),
    });
    expect(response).toBeDefined();
    const body = await response!.json();

    expect(response!.status).toBe(200);
    expect(upsertProjectMcpConnectionMock).toHaveBeenCalledWith({ tag: 'admin' }, {
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
      serverKey: 'linear',
      secret: 'lin_api_key',
      label: 'Moonklabs Linear',
    });
    expect(body.data.displayName).toBe('Linear');
  });

  it('deletes a connection and suspends live deployments', async () => {
    const response = await DELETE(new Request('https://sprintable.app/api/projects/project-1/mcp-connections/github', {
      method: 'DELETE',
    }), {
      params: Promise.resolve({ id: 'project-1', serverKey: 'github' }),
    });
    expect(response).toBeDefined();
    const body = await response!.json();

    expect(response!.status).toBe(200);
    expect(deleteProjectMcpConnectionMock).toHaveBeenCalledWith({ tag: 'admin' }, {
      projectId: 'project-1',
      serverKey: 'github',
    });
    expect(transitionDeploymentMock).toHaveBeenCalledWith({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
      deploymentId: 'deployment-1',
      status: 'SUSPENDED',
    });
    expect(body.data.suspended_deployments).toBe(1);
  });
});
