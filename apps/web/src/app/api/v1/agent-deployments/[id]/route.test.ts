import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSupabaseServerClient,
  getMyTeamMember,
  requireOrgAdmin,
  transitionDeployment,
  terminateDeployment,
  requireAgentOrchestration,
} = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
  transitionDeployment: vi.fn(),
  terminateDeployment: vi.fn(),
  requireAgentOrchestration: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return { ...actual, getMyTeamMember };
});
vi.mock('@/lib/admin-check', () => ({ requireOrgAdmin }));
vi.mock('@/lib/require-agent-orchestration', () => ({ requireAgentOrchestration }));
vi.mock('@/services/agent-deployment-lifecycle', () => ({
  DeploymentLifecycleError: class DeploymentLifecycleError extends Error {
    constructor(public code: string, message: string, public status: number) {
      super(message);
      this.name = 'DeploymentLifecycleError';
    }
  },
  AgentDeploymentLifecycleService: class {
    transitionDeployment = transitionDeployment;
    terminateDeployment = terminateDeployment;
  },
}));

import { DELETE, GET, PATCH } from './route';

describe('/api/v1/agent-deployments/[id]', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    transitionDeployment.mockReset();
    terminateDeployment.mockReset();
    requireAgentOrchestration.mockReset();

    createSupabaseServerClient.mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
      },
    });
    getMyTeamMember.mockResolvedValue({
      id: 'member-1',
      org_id: 'org-1',
      project_id: 'project-1',
    });
    requireAgentOrchestration.mockResolvedValue(null);
  });

  it('blocks deployment detail reads when upgrade is required', async () => {
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await GET(new Request('http://localhost/api/v1/agent-deployments/dep-1'), {
      params: Promise.resolve({ id: 'dep-1' }),
    });

    expect(response.status).toBe(403);
  });

  it('transitions a deployment inside the current scope', async () => {
    transitionDeployment.mockResolvedValue({ id: 'dep-1', status: 'SUSPENDED' });

    const response = await PATCH(new Request('http://localhost/api/v1/agent-deployments/dep-1', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'SUSPENDED' }),
    }), {
      params: Promise.resolve({ id: 'dep-1' }),
    });

    expect(response.status).toBe(200);
    expect(transitionDeployment).toHaveBeenCalledWith({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
      deploymentId: 'dep-1',
      status: 'SUSPENDED',
      failure: null,
    });
  });

  it('rejects deployment termination bypass when upgrade is required', async () => {
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await DELETE(new Request('http://localhost/api/v1/agent-deployments/dep-1', {
      method: 'DELETE',
    }), {
      params: Promise.resolve({ id: 'dep-1' }),
    });

    expect(response.status).toBe(403);
    expect(terminateDeployment).not.toHaveBeenCalled();
  });
});
