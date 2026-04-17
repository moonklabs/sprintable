import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KmsServiceError } from '@/lib/kms';

const {
  createSupabaseServerClient,
  getMyTeamMember,
  requireOrgAdmin,
  getProjectAiSettingsWithIntegration,
  ensureProjectSecretEncrypted,
  decryptProjectSecret,
  persistProjectAiSettingsWithEncryptedSecret,
} = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
  getProjectAiSettingsWithIntegration: vi.fn(),
  ensureProjectSecretEncrypted: vi.fn(),
  decryptProjectSecret: vi.fn(),
  persistProjectAiSettingsWithEncryptedSecret: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient,
}));

vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return {
    ...actual,
    getMyTeamMember,
  };
});

vi.mock('@/lib/admin-check', () => ({
  requireOrgAdmin,
}));

vi.mock('@/lib/llm/project-ai-settings', () => ({
  ORG_INTEGRATION_TYPE: 'byom_api_key',
  maskLast4: (last4?: string | null) => (last4 ? `****${last4}` : null),
  getProjectAiSettingsWithIntegration,
  ensureProjectSecretEncrypted,
  decryptProjectSecret,
  persistProjectAiSettingsWithEncryptedSecret,
}));

import { DELETE, GET, PUT } from './route';

function createSupabaseStub() {
  const projectUpsertSpy = vi.fn();
  const rotationUpdateSpy = vi.fn();
  const deploymentUpdateSpy = vi.fn();
  const projectDeleteSpy = vi.fn();
  const integrationDeleteSpy = vi.fn();

  const projectQuery = {
    upsert: vi.fn((payload: unknown) => {
      projectUpsertSpy(payload);
      return projectQuery;
    }),
    select: vi.fn(() => projectQuery),
    single: vi.fn().mockResolvedValue({
      data: {
        id: 'setting-1',
        provider: 'openai',
        llm_config: { model: 'gpt-4o-mini' },
        created_at: '2026-04-07T09:00:00.000Z',
        updated_at: '2026-04-07T09:00:00.000Z',
      },
      error: null,
    }),
    delete: vi.fn(() => projectDeleteQuery),
  };

  let rotationEqCount = 0;
  const orgIntegrationUpdateQuery = {
    update: vi.fn((payload: unknown) => {
      rotationUpdateSpy(payload);
      rotationEqCount = 0;
      return orgIntegrationUpdateQuery;
    }),
    eq: vi.fn(() => {
      rotationEqCount += 1;
      if (rotationEqCount >= 3) return Promise.resolve({ error: null });
      return orgIntegrationUpdateQuery;
    }),
  };

  let deploymentEqCount = 0;
  const deploymentUpdateQuery = {
    update: vi.fn((payload: unknown) => {
      deploymentUpdateSpy(payload);
      deploymentEqCount = 0;
      return deploymentUpdateQuery;
    }),
    eq: vi.fn(() => {
      deploymentEqCount += 1;
      return deploymentUpdateQuery;
    }),
    in: vi.fn(async () => ({ error: null })),
  };

  const projectDeleteQuery = {
    delete: vi.fn(() => projectDeleteQuery),
    eq: vi.fn((column: string, value: unknown) => {
      projectDeleteSpy({ column, value });
      return Promise.resolve({ error: null });
    }),
  };

  let integrationDeleteEqCount = 0;
  const orgIntegrationDeleteQuery = {
    delete: vi.fn(() => orgIntegrationDeleteQuery),
    eq: vi.fn((column: string, value: unknown) => {
      integrationDeleteEqCount += 1;
      if (integrationDeleteEqCount >= 3) {
        integrationDeleteSpy({ column, value });
        return Promise.resolve({ error: null });
      }
      return orgIntegrationDeleteQuery;
    }),
  };

  let orgIntegrationFromCount = 0;

  const supabase = {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }),
    },
    from: vi.fn((table: string) => {
      if (table === 'project_ai_settings') return projectQuery;
      if (table === 'agent_deployments') return deploymentUpdateQuery;
      if (table === 'org_integrations') {
        orgIntegrationFromCount += 1;
        return orgIntegrationFromCount === 1 ? orgIntegrationUpdateQuery : orgIntegrationDeleteQuery;
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  };

  return {
    supabase,
    projectUpsertSpy,
    rotationUpdateSpy,
    deploymentUpdateSpy,
    projectDeleteSpy,
    integrationDeleteSpy,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.KMS_PROVIDER = 'local';
  process.env.LOCAL_KMS_MASTER_KEY = 'route-test-master-key';
  getMyTeamMember.mockResolvedValue({ id: 'tm-1', org_id: 'org-1', project_id: 'project-1' });
  requireOrgAdmin.mockResolvedValue(undefined);
  getProjectAiSettingsWithIntegration.mockResolvedValue({ settings: null, integration: null });
});

describe('GET /api/projects/[id]/ai-settings', () => {
  it('returns masked BYOM metadata from org_integrations, not plaintext api_key', async () => {
    const { supabase } = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    getProjectAiSettingsWithIntegration.mockResolvedValue({
      settings: {
        id: 'setting-1',
        org_id: 'org-1',
        project_id: 'project-1',
        provider: 'openai',
        api_key: null,
        llm_config: { model: 'gpt-4o-mini' },
        created_at: '2026-04-07T09:00:00.000Z',
        updated_at: '2026-04-07T09:00:00.000Z',
      },
      integration: { secret_last4: '1234', encrypted_secret: 'encrypted' },
    });
    ensureProjectSecretEncrypted.mockResolvedValue({ secret_last4: '1234', encrypted_secret: 'encrypted' });

    const response = await GET(new Request('http://localhost/api/projects/project-1/ai-settings'), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.api_key).toBe('****1234');
  });

  it('returns a safe 503 message when KMS is unavailable', async () => {
    const { supabase } = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    getProjectAiSettingsWithIntegration.mockResolvedValue({
      settings: { org_id: 'org-1', project_id: 'project-1', provider: 'openai', api_key: null, llm_config: {} },
      integration: { secret_last4: '1234', encrypted_secret: 'encrypted' },
    });
    ensureProjectSecretEncrypted.mockRejectedValue(new KmsServiceError('vault down'));

    const response = await GET(new Request('http://localhost/api/projects/project-1/ai-settings'), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.message).toBe('KMS 서비스 일시 오류');
  });
});

describe('PUT /api/projects/[id]/ai-settings', () => {
  it('returns validation errors for malformed payloads', async () => {
    const { supabase } = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);

    const response = await PUT(new Request('http://localhost/api/projects/project-1/ai-settings', {
      method: 'PUT',
      body: JSON.stringify({ provider: 'invalid-provider' }),
      headers: { 'Content-Type': 'application/json' },
    }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('requires a fresh api_key when the provider changes', async () => {
    const { supabase, projectUpsertSpy } = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    getProjectAiSettingsWithIntegration.mockResolvedValue({
      settings: {
        org_id: 'org-1',
        project_id: 'project-1',
        provider: 'openai',
        api_key: null,
        llm_config: { model: 'gpt-4o-mini' },
      },
      integration: { secret_last4: '1111', encrypted_secret: 'encrypted' },
    });
    ensureProjectSecretEncrypted.mockResolvedValue({ secret_last4: '1111', encrypted_secret: 'encrypted' });

    const response = await PUT(new Request('http://localhost/api/projects/project-1/ai-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'google', llm_config: { model: 'gemini-2.5-flash' } }),
    }), { params: Promise.resolve({ id: 'project-1' }) });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toBe('api_key is required when provider changes');
    expect(projectUpsertSpy).not.toHaveBeenCalled();
  });

  it('rejects direct legacy MCP configuration writes', async () => {
    const { supabase, projectUpsertSpy } = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    getProjectAiSettingsWithIntegration.mockResolvedValue({ settings: null, integration: null });

    const response = await PUT(new Request('http://localhost/api/projects/project-1/ai-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        api_key: 'sk-openai-1234',
        llm_config: {
          model: 'gpt-4o-mini',
          mcp_servers: [{
            name: 'rogue',
            url: 'https://rogue.example.com/rpc',
            allowed_tools: ['external.exfiltrate'],
          }],
        },
      }),
    }), { params: Promise.resolve({ id: 'project-1' }) });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: 'llm_config',
        message: 'External MCP connections must be managed from approved MCP settings',
      }),
    ]));
    expect(projectUpsertSpy).not.toHaveBeenCalled();
    expect(persistProjectAiSettingsWithEncryptedSecret).not.toHaveBeenCalled();
  });

  it('stores encrypted BYOM metadata atomically without persisting plaintext to project_ai_settings', async () => {
    const { supabase, projectUpsertSpy } = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    getProjectAiSettingsWithIntegration.mockResolvedValue({ settings: null, integration: null });
    ensureProjectSecretEncrypted.mockResolvedValue(null);
    persistProjectAiSettingsWithEncryptedSecret.mockResolvedValue({
      data: {
        id: 'setting-1',
        provider: 'openai-compatible',
        llm_config: { baseUrl: 'https://llm.example.com/v1' },
        created_at: '2026-04-07T09:00:00.000Z',
        updated_at: '2026-04-07T09:00:00.000Z',
      },
      encryptedSecret: '{...}',
      updatedAt: '2026-04-07T09:00:00.000Z',
    });

    const response = await PUT(new Request('http://localhost/api/projects/project-1/ai-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai-compatible',
        api_key: 'sk-compatible-1234',
        llm_config: { baseUrl: 'https://llm.example.com/v1/' },
      }),
    }), { params: Promise.resolve({ id: 'project-1' }) });

    expect(response.status).toBe(200);
    expect(projectUpsertSpy).not.toHaveBeenCalled();
    expect(persistProjectAiSettingsWithEncryptedSecret).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        orgId: 'org-1',
        projectId: 'project-1',
        provider: 'openai-compatible',
        plaintextSecret: 'sk-compatible-1234',
        llmConfig: expect.objectContaining({ baseUrl: 'https://llm.example.com/v1' }),
      }),
    );
  });

  it('drops carried legacy MCP config when re-saving AI settings', async () => {
    const { supabase } = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    getProjectAiSettingsWithIntegration.mockResolvedValue({
      settings: {
        org_id: 'org-1',
        project_id: 'project-1',
        provider: 'openai',
        api_key: null,
        llm_config: {
          model: 'gpt-4o-mini',
          mcp_servers: [{
            name: 'legacy-docs',
            url: 'https://legacy-docs.example.com/rpc',
            allowed_tools: ['external.search_docs'],
          }],
          github_mcp: {
            gateway_url: 'https://legacy-github.example.com/rpc',
            auth: { token_ref: 'MCP_TOKEN_GITHUB' },
          },
        },
      },
      integration: { secret_last4: '1111', encrypted_secret: 'encrypted' },
    });
    ensureProjectSecretEncrypted.mockResolvedValue({ secret_last4: '1111', encrypted_secret: 'encrypted' });
    decryptProjectSecret.mockResolvedValue('sk-openai-1111');
    persistProjectAiSettingsWithEncryptedSecret.mockResolvedValue({
      data: {
        id: 'setting-1',
        provider: 'openai',
        llm_config: { model: 'gpt-4o' },
        created_at: '2026-04-07T09:00:00.000Z',
        updated_at: '2026-04-07T09:00:00.000Z',
      },
      encryptedSecret: '{...}',
      updatedAt: '2026-04-07T09:00:00.000Z',
    });

    const response = await PUT(new Request('http://localhost/api/projects/project-1/ai-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', llm_config: { model: 'gpt-4o' } }),
    }), { params: Promise.resolve({ id: 'project-1' }) });

    expect(response.status).toBe(200);
    expect(persistProjectAiSettingsWithEncryptedSecret).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        llmConfig: expect.not.objectContaining({
          mcp_servers: expect.anything(),
          github_mcp: expect.anything(),
        }),
      }),
    );
  });

  it('reuses the existing encrypted secret when the provider is unchanged', async () => {
    const { supabase } = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    getProjectAiSettingsWithIntegration.mockResolvedValue({
      settings: {
        org_id: 'org-1',
        project_id: 'project-1',
        provider: 'openai',
        api_key: null,
        llm_config: { model: 'gpt-4o-mini' },
      },
      integration: { secret_last4: '1111', encrypted_secret: 'encrypted' },
    });
    ensureProjectSecretEncrypted.mockResolvedValue({ secret_last4: '1111', encrypted_secret: 'encrypted' });
    decryptProjectSecret.mockResolvedValue('sk-openai-1111');
    persistProjectAiSettingsWithEncryptedSecret.mockResolvedValue({
      data: {
        id: 'setting-1',
        provider: 'openai',
        llm_config: { model: 'gpt-4o' },
        created_at: '2026-04-07T09:00:00.000Z',
        updated_at: '2026-04-07T09:00:00.000Z',
      },
      encryptedSecret: '{...}',
      updatedAt: '2026-04-07T09:00:00.000Z',
    });

    const response = await PUT(new Request('http://localhost/api/projects/project-1/ai-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', llm_config: { model: 'gpt-4o' } }),
    }), { params: Promise.resolve({ id: 'project-1' }) });

    expect(response.status).toBe(200);
    expect(persistProjectAiSettingsWithEncryptedSecret).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ plaintextSecret: 'sk-openai-1111' }),
    );
  });

  it('returns 503 and avoids partial writes when transactional secret persistence fails', async () => {
    const { supabase, projectUpsertSpy } = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    getProjectAiSettingsWithIntegration.mockResolvedValue({ settings: null, integration: null });
    persistProjectAiSettingsWithEncryptedSecret.mockRejectedValue(new KmsServiceError('vault down'));

    const response = await PUT(new Request('http://localhost/api/projects/project-1/ai-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        api_key: 'sk-openai-1234',
        llm_config: { model: 'gpt-4o-mini' },
      }),
    }), { params: Promise.resolve({ id: 'project-1' }) });

    expect(response.status).toBe(503);
    expect(projectUpsertSpy).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/projects/[id]/ai-settings', () => {
  it('requests KMS rotation, marks deployments failed, and deletes the integration', async () => {
    const { supabase, rotationUpdateSpy, deploymentUpdateSpy, projectDeleteSpy, integrationDeleteSpy } = createSupabaseStub();
    createSupabaseServerClient.mockResolvedValue(supabase);
    getProjectAiSettingsWithIntegration.mockResolvedValue({
      settings: {
        org_id: 'org-1',
        project_id: 'project-1',
        provider: 'openai',
        api_key: null,
        llm_config: { model: 'gpt-4o-mini' },
      },
      integration: {
        org_id: 'org-1',
        project_id: 'project-1',
        integration_type: 'byom_api_key',
        provider: 'openai',
        secret_last4: '1111',
        encrypted_secret: '{"kmsProvider":"local"}',
        kms_provider: 'local',
      },
    });

    const response = await DELETE(new Request('http://localhost/api/projects/project-1/ai-settings', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'project-1' }),
    });

    expect(response.status).toBe(200);
    expect(rotationUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ kms_status: 'rotation_requested' }));
    expect(deploymentUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: 'DEPLOY_FAILED',
      failure_code: 'project_ai_settings_deleted',
      failure_message: expect.stringContaining('managed deployment no longer has a valid credential source'),
    }));
    expect(projectDeleteSpy).toHaveBeenCalledWith({ column: 'project_id', value: 'project-1' });
    expect(integrationDeleteSpy).toHaveBeenCalledWith({ column: 'integration_type', value: 'byom_api_key' });

    const body = await response.json();
    expect(body.data.kms_rotation.requested).toBe(true);
    expect(body.data.kms_rotation.executed).toBe(true);
    expect(body.data.kms_rotation.provider).toBe('local');
    expect(body.data.kms_rotation.rotated_key_version).toMatch(/^local-/);
    expect(body.data.deployments_marked_failed).toBe(true);
  });
});
