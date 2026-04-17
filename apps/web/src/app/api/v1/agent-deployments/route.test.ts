import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSupabaseServerClient,
  getMyTeamMember,
  requireOrgAdmin,
  buildDeploymentCards,
  createDeployment,
  requireAgentOrchestration,
  getProjectAiSettingsWithIntegrationMock,
} = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
  buildDeploymentCards: vi.fn(),
  createDeployment: vi.fn(),
  requireAgentOrchestration: vi.fn(),
  getProjectAiSettingsWithIntegrationMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return { ...actual, getMyTeamMember };
});
vi.mock('@/lib/admin-check', () => ({ requireOrgAdmin }));
vi.mock('@/services/agent-dashboard', () => ({ buildDeploymentCards }));
vi.mock('@/lib/require-agent-orchestration', () => ({ requireAgentOrchestration }));
vi.mock('@/lib/llm/project-ai-settings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/llm/project-ai-settings')>('@/lib/llm/project-ai-settings');
  return { ...actual, getProjectAiSettingsWithIntegration: getProjectAiSettingsWithIntegrationMock };
});
vi.mock('@/services/agent-deployment-lifecycle', () => ({
  DeploymentLifecycleError: class DeploymentLifecycleError extends Error {
    constructor(public code: string, public status: number, message: string, public details?: Record<string, unknown>) {
      super(message);
      this.name = 'DeploymentLifecycleError';
    }
  },
  AgentDeploymentLifecycleService: class {
    createDeployment = createDeployment;
  },
}));

import { GET, POST } from './route';

describe('/api/v1/agent-deployments', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    buildDeploymentCards.mockReset();
    createDeployment.mockReset();
    requireAgentOrchestration.mockReset();
    getProjectAiSettingsWithIntegrationMock.mockReset();

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
    getProjectAiSettingsWithIntegrationMock.mockResolvedValue({ settings: null, integration: null });
  });

  it('lists deployment cards when agent orchestration is enabled', async () => {
    buildDeploymentCards.mockResolvedValue([{ id: 'dep-1', name: 'Reviewer' }]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(requireAgentOrchestration).toHaveBeenCalledWith(expect.anything(), 'org-1');
    await expect(response.json()).resolves.toMatchObject({
      data: [{ id: 'dep-1', name: 'Reviewer' }],
    });
  });

  it('blocks deployment dashboard API access when upgrade is required', async () => {
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await GET();

    expect(response.status).toBe(403);
    expect(buildDeploymentCards).not.toHaveBeenCalled();
  });

  it('creates a deployment inside the current org/project scope', async () => {
    createDeployment.mockResolvedValue({ id: 'dep-1', status: 'DEPLOYING' });

    const response = await POST(new Request('http://localhost/api/v1/agent-deployments', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: '11111111-1111-4111-8111-111111111111',
        name: 'Reviewer',
        persona_id: '22222222-2222-4222-8222-222222222222',
        config: {
          schema_version: 1,
          llm_mode: 'managed',
          provider: 'openai',
          scope_mode: 'projects',
          project_ids: ['33333333-3333-4333-8333-333333333333'],
        },
      }),
    }));

    expect(response.status).toBe(202);
    expect(createDeployment).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
      agentId: '11111111-1111-4111-8111-111111111111',
      name: 'Reviewer',
      personaId: '22222222-2222-4222-8222-222222222222',
      config: expect.objectContaining({
        llm_mode: 'managed',
        provider: 'openai',
      }),
    }));
  });

  it('rejects BYOM deployment creation when the stored project credential provider does not match', async () => {
    getProjectAiSettingsWithIntegrationMock.mockResolvedValue({
      settings: {
        org_id: 'org-1',
        project_id: 'project-1',
        provider: 'openai',
        llm_config: { model: 'gpt-4o-mini' },
      },
      integration: {
        org_id: 'org-1',
        project_id: 'project-1',
        integration_type: 'byom_api_key',
        provider: 'openai',
        secret_last4: '1234',
        encrypted_secret: 'encrypted',
      },
    });

    const response = await POST(new Request('http://localhost/api/v1/agent-deployments', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: '11111111-1111-4111-8111-111111111111',
        name: 'Reviewer',
        config: {
          schema_version: 1,
          llm_mode: 'byom',
          provider: 'anthropic',
          scope_mode: 'projects',
          project_ids: ['33333333-3333-4333-8333-333333333333'],
        },
      }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'BYOM_PROVIDER_MISMATCH',
      },
    });
    expect(createDeployment).not.toHaveBeenCalled();
  });

  it('returns structured preflight details when creation is blocked server-side', async () => {
    const { DeploymentLifecycleError } = await import('@/services/agent-deployment-lifecycle');
    createDeployment.mockRejectedValue(new DeploymentLifecycleError(
      'DEPLOYMENT_PREFLIGHT_FAILED',
      409,
      'Resolve preflight issues before deploying',
      {
        preflight: {
          ok: false,
          blocking_reasons: ['Managed deployment validation failed for one or more MCP connections'],
        },
      },
    ));

    const response = await POST(new Request('http://localhost/api/v1/agent-deployments', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: '11111111-1111-4111-8111-111111111111',
        name: 'Reviewer',
        config: {
          schema_version: 1,
          llm_mode: 'managed',
          provider: 'openai',
          scope_mode: 'projects',
          project_ids: ['33333333-3333-4333-8333-333333333333'],
        },
      }),
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'DEPLOYMENT_PREFLIGHT_FAILED',
        details: {
          preflight: {
            ok: false,
          },
        },
      },
    });
  });

  it('rejects deployment creation bypass when upgrade is required', async () => {
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await POST(new Request('http://localhost/api/v1/agent-deployments', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: '11111111-1111-4111-8111-111111111111',
        name: 'Reviewer',
        config: {
          schema_version: 1,
          llm_mode: 'managed',
          provider: 'openai',
          scope_mode: 'projects',
          project_ids: ['33333333-3333-4333-8333-333333333333'],
        },
      }),
    }));

    expect(response.status).toBe(403);
    expect(createDeployment).not.toHaveBeenCalled();
  });
});
