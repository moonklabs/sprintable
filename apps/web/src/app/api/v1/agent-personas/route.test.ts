import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createDbServerClient,
  getMyTeamMember,
  requireOrgAdmin,
  listPersonas,
  createPersona,
  requireAgentOrchestration,
} = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
  listPersonas: vi.fn(),
  createPersona: vi.fn(),
  requireAgentOrchestration: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  createDbServerClient,
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

vi.mock('@/lib/require-agent-orchestration', () => ({
  requireAgentOrchestration,
}));

vi.mock('@/services/agent-persona', () => ({
  AgentPersonaService: class {
    listPersonas = listPersonas;
    createPersona = createPersona;
  },
}));

import { GET, POST } from './route';

describe('GET /api/v1/agent-personas', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    requireAgentOrchestration.mockReset();
    listPersonas.mockReset();
    createPersona.mockReset();

    createDbServerClient.mockResolvedValue({
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

  it('requires agent_id', async () => {
    const response = await GET(new Request('http://localhost/api/v1/agent-personas'));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toBe('agent_id required');
  });

  it('blocks persona reads when upgrade is required', async () => {
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await GET(new Request('http://localhost/api/v1/agent-personas?agent_id=agent-1'));

    expect(response.status).toBe(403);
    expect(listPersonas).not.toHaveBeenCalled();
  });

  it('defaults include_builtin to false', async () => {
    listPersonas.mockResolvedValue([{ id: 'persona-1', slug: 'custom' }]);

    const response = await GET(new Request('http://localhost/api/v1/agent-personas?agent_id=agent-1'));

    expect(response.status).toBe(200);
    expect(listPersonas).toHaveBeenCalledWith({
      orgId: 'org-1',
      projectId: 'project-1',
      agentId: 'agent-1',
      includeBuiltin: false,
    });

    const body = await response.json();
    expect(body.data).toEqual([{ id: 'persona-1', slug: 'custom' }]);
  });

  it('passes include_builtin=true through to the service', async () => {
    listPersonas.mockResolvedValue([
      { id: 'persona-1', slug: 'general', is_builtin: true },
      { id: 'persona-2', slug: 'custom', is_builtin: false },
    ]);

    const response = await GET(new Request('http://localhost/api/v1/agent-personas?agent_id=agent-1&include_builtin=true'));

    expect(response.status).toBe(200);
    expect(listPersonas).toHaveBeenCalledWith({
      orgId: 'org-1',
      projectId: 'project-1',
      agentId: 'agent-1',
      includeBuiltin: true,
    });
  });
});

describe('POST /api/v1/agent-personas', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    requireAgentOrchestration.mockReset();
    createPersona.mockReset();

    createDbServerClient.mockResolvedValue({
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

  it('rejects creation bypass when upgrade is required', async () => {
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await POST(new Request('http://localhost/api/v1/agent-personas', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: 'agent-1',
        name: 'Custom Dev',
      }),
    }));

    expect(response.status).toBe(403);
    expect(createPersona).not.toHaveBeenCalled();
  });

  it('creates a custom persona inside the current org/project scope', async () => {
    createPersona.mockResolvedValue({ id: 'persona-1', slug: 'custom-dev', is_in_use: false });

    const response = await POST(new Request('http://localhost/api/v1/agent-personas', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: 'agent-1',
        name: 'Custom Dev',
        base_persona_id: 'builtin-dev',
        tool_allowlist: ['get_source_memo', 'resolve_memo'],
        is_default: true,
      }),
    }));

    expect(response.status).toBe(201);
    expect(requireOrgAdmin).toHaveBeenCalledWith(expect.anything(), 'org-1');
    expect(createPersona).toHaveBeenCalledWith({
      orgId: 'org-1',
      projectId: 'project-1',
      agentId: 'agent-1',
      actorId: 'member-1',
      name: 'Custom Dev',
      base_persona_id: 'builtin-dev',
      tool_allowlist: ['get_source_memo', 'resolve_memo'],
      is_default: true,
    });
  });

  it('returns validation errors for malformed payloads', async () => {
    const response = await POST(new Request('http://localhost/api/v1/agent-personas', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: '',
        name: '',
      }),
    }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});
