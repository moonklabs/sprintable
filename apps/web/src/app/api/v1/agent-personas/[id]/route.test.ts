import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSupabaseServerClient,
  getMyTeamMember,
  requireOrgAdmin,
  requireAgentOrchestration,
  getPersonaById,
  updatePersona,
  deletePersona,
} = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
  requireAgentOrchestration: vi.fn(),
  getPersonaById: vi.fn(),
  updatePersona: vi.fn(),
  deletePersona: vi.fn(),
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

vi.mock('@/lib/require-agent-orchestration', () => ({
  requireAgentOrchestration,
}));

vi.mock('@/services/agent-persona', () => ({
  AgentPersonaService: class {
    getPersonaById = getPersonaById;
    updatePersona = updatePersona;
    deletePersona = deletePersona;
  },
}));

import { DELETE, GET, PATCH } from './route';

describe('/api/v1/agent-personas/[id]', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    requireAgentOrchestration.mockReset();
    getPersonaById.mockReset();
    updatePersona.mockReset();
    deletePersona.mockReset();

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

  it('blocks persona detail reads when upgrade is required', async () => {
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await GET(new Request('http://localhost/api/v1/agent-personas/persona-1'), {
      params: Promise.resolve({ id: 'persona-1' }),
    });

    expect(response.status).toBe(403);
    expect(getPersonaById).not.toHaveBeenCalled();
  });

  it('returns a persona with current scope filtering', async () => {
    getPersonaById.mockResolvedValue({ id: 'persona-1', slug: 'custom-dev', is_in_use: true });

    const response = await GET(new Request('http://localhost/api/v1/agent-personas/persona-1'), {
      params: Promise.resolve({ id: 'persona-1' }),
    });

    expect(response.status).toBe(200);
    expect(getPersonaById).toHaveBeenCalledWith('persona-1', {
      orgId: 'org-1',
      projectId: 'project-1',
    });
  });

  it('updates a custom persona', async () => {
    updatePersona.mockResolvedValue({ id: 'persona-1', slug: 'custom-dev-v2', is_in_use: false });

    const response = await PATCH(new Request('http://localhost/api/v1/agent-personas/persona-1', {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'Custom Dev v2',
        tool_allowlist: ['get_source_memo'],
        is_default: true,
      }),
    }), {
      params: Promise.resolve({ id: 'persona-1' }),
    });

    expect(response.status).toBe(200);
    expect(requireOrgAdmin).toHaveBeenCalledWith(expect.anything(), 'org-1');
    expect(updatePersona).toHaveBeenCalledWith('persona-1', {
      orgId: 'org-1',
      projectId: 'project-1',
    }, {
      actorId: 'member-1',
      name: 'Custom Dev v2',
      tool_allowlist: ['get_source_memo'],
      is_default: true,
    });
  });

  it('rejects persona deletion bypass when upgrade is required', async () => {
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await DELETE(new Request('http://localhost/api/v1/agent-personas/persona-1', {
      method: 'DELETE',
    }), {
      params: Promise.resolve({ id: 'persona-1' }),
    });

    expect(response.status).toBe(403);
    expect(deletePersona).not.toHaveBeenCalled();
  });

  it('soft deletes a persona', async () => {
    deletePersona.mockResolvedValue({ ok: true, id: 'persona-1' });

    const response = await DELETE(new Request('http://localhost/api/v1/agent-personas/persona-1', {
      method: 'DELETE',
    }), {
      params: Promise.resolve({ id: 'persona-1' }),
    });

    expect(response.status).toBe(200);
    expect(deletePersona).toHaveBeenCalledWith('persona-1', {
      orgId: 'org-1',
      projectId: 'project-1',
    }, 'member-1');
  });
});
