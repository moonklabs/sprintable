import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSupabaseServerClient,
  getMyTeamMember,
  requireOrgAdmin,
  runDeploymentPreflight,
  requireAgentOrchestration,
  getProjectAiSettingsWithIntegrationMock,
} = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
  runDeploymentPreflight: vi.fn(),
  requireAgentOrchestration: vi.fn(),
  getProjectAiSettingsWithIntegrationMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return { ...actual, getMyTeamMember };
});
vi.mock('@/lib/admin-check', () => ({ requireOrgAdmin }));
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
    runDeploymentPreflight = runDeploymentPreflight;
  },
}));

import { POST } from './route';

describe('/api/v1/agent-deployments/preflight', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    runDeploymentPreflight.mockReset();
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
    runDeploymentPreflight.mockResolvedValue({
      ok: true,
      checked_at: '2026-04-12T05:10:00.000Z',
      blocking_reasons: [],
      warnings: [],
      routing_template_id: 'po-dev',
      routing_rule_count: 2,
      existing_routing_rule_count: 0,
      requires_routing_overwrite_confirmation: false,
      mcp_validation_errors: [],
    });
  });

  it('returns a ready preflight summary when deployment checks pass', async () => {
    const response = await POST(new Request('http://localhost/api/v1/agent-deployments/preflight', {
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

    expect(response.status).toBe(200);
    expect(runDeploymentPreflight).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
      agentId: '11111111-1111-4111-8111-111111111111',
    }));
    await expect(response.json()).resolves.toMatchObject({
      data: {
        preflight: {
          ok: true,
          routing_template_id: 'po-dev',
        },
      },
    });
  });

  it('surfaces BYOM provider mismatch as a blocking preflight reason', async () => {
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

    const response = await POST(new Request('http://localhost/api/v1/agent-deployments/preflight', {
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

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        preflight: {
          ok: false,
          blocking_reasons: [
            'Project AI settings are configured for provider openai; BYOM deployments must use the same provider',
          ],
        },
      },
    });
  });
});
