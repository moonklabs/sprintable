import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSupabaseServerClient,
  getMyTeamMember,
  requireOrgAdmin,
  completeDeploymentVerification,
  requireAgentOrchestration,
} = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
  completeDeploymentVerification: vi.fn(),
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
    constructor(public code: string, public status: number, message: string, public details?: Record<string, unknown>) {
      super(message);
      this.name = 'DeploymentLifecycleError';
    }
  },
  AgentDeploymentLifecycleService: class {
    completeDeploymentVerification = completeDeploymentVerification;
  },
}));

import { POST } from './route';

describe('/api/v1/agent-deployments/[id]/verification', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    completeDeploymentVerification.mockReset();
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

  it('marks an active deployment verification as completed inside the current scope', async () => {
    completeDeploymentVerification.mockResolvedValue({
      deployment: {
        id: 'dep-1',
        status: 'ACTIVE',
        config: {
          verification: {
            status: 'completed',
            completed_at: '2026-04-12T05:30:00.000Z',
            completed_by: 'member-1',
          },
        },
      },
    });

    const response = await POST(new Request('http://localhost/api/v1/agent-deployments/dep-1/verification', {
      method: 'POST',
    }), {
      params: Promise.resolve({ id: 'dep-1' }),
    });

    expect(response.status).toBe(200);
    expect(completeDeploymentVerification).toHaveBeenCalledWith({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
      deploymentId: 'dep-1',
    });
  });

  it('blocks deployment verification completion when upgrade is required', async () => {
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await POST(new Request('http://localhost/api/v1/agent-deployments/dep-1/verification', {
      method: 'POST',
    }), {
      params: Promise.resolve({ id: 'dep-1' }),
    });

    expect(response.status).toBe(403);
    expect(completeDeploymentVerification).not.toHaveBeenCalled();
  });
});
