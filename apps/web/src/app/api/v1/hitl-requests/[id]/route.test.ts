import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient, getMyTeamMember, requireOrgAdmin, requireAgentOrchestration, respond } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  getMyTeamMember: vi.fn(),
  requireOrgAdmin: vi.fn(),
  requireAgentOrchestration: vi.fn(),
  respond: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/auth-helpers', () => ({ getMyTeamMember }));
vi.mock('@/lib/admin-check', () => ({ requireOrgAdmin }));
vi.mock('@/lib/require-agent-orchestration', () => ({ requireAgentOrchestration }));
vi.mock('@/services/agent-hitl', async () => {
  class HitlConflictError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'HitlConflictError';
    }
  }

  class AgentHitlService {
    respond = respond;
  }

  return {
    HitlConflictError,
    AgentHitlService,
  };
});

import { PATCH } from './route';

describe('PATCH /api/v1/hitl-requests/[id]', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getMyTeamMember.mockReset();
    requireOrgAdmin.mockReset();
    requireAgentOrchestration.mockReset();
    respond.mockReset();
    requireAgentOrchestration.mockResolvedValue(null);
  });

  it('returns unauthorized when no auth user exists', async () => {
    createSupabaseServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    });

    const response = await PATCH(new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'approve' }),
    }), { params: Promise.resolve({ id: 'hitl-1' }) });

    expect(response.status).toBe(401);
  });

  it('blocks approve/reject bypass when upgrade is required', async () => {
    createSupabaseServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
    });
    getMyTeamMember.mockResolvedValue({ id: 'admin-1', org_id: 'org-1', project_id: 'project-1' });
    requireOrgAdmin.mockResolvedValue(undefined);
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await PATCH(new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'approve' }),
    }), { params: Promise.resolve({ id: 'hitl-1' }) });

    expect(response.status).toBe(403);
    expect(respond).not.toHaveBeenCalled();
  });

  it('maps service conflicts to 409', async () => {
    createSupabaseServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
    });
    getMyTeamMember.mockResolvedValue({ id: 'admin-1', org_id: 'org-1', project_id: 'project-1' });
    requireOrgAdmin.mockResolvedValue(undefined);

    const { HitlConflictError } = await import('@/services/agent-hitl');
    respond.mockRejectedValue(new HitlConflictError('already processed'));

    const response = await PATCH(new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'approve' }),
    }), { params: Promise.resolve({ id: 'hitl-1' }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'CONFLICT', message: 'already processed' },
    });
  });

  it('returns approved payload on success', async () => {
    createSupabaseServerClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-1' } } }) },
    });
    getMyTeamMember.mockResolvedValue({ id: 'admin-1', org_id: 'org-1', project_id: 'project-1' });
    requireOrgAdmin.mockResolvedValue(undefined);
    respond.mockResolvedValue({ id: 'hitl-1', status: 'approved', resumed_run_id: 'run-2' });

    const response = await PATCH(new Request('http://localhost', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'approve', comment: 'go' }),
    }), { params: Promise.resolve({ id: 'hitl-1' }) });

    expect(response.status).toBe(200);
    expect(requireAgentOrchestration).toHaveBeenCalledWith(expect.anything(), 'org-1');
    await expect(response.json()).resolves.toMatchObject({
      data: { id: 'hitl-1', status: 'approved', resumed_run_id: 'run-2' },
    });
    expect(respond).toHaveBeenCalledWith({
      requestId: 'hitl-1',
      actorId: 'admin-1',
      orgId: 'org-1',
      projectId: 'project-1',
      action: 'approve',
      comment: 'go',
    });
  });
});
