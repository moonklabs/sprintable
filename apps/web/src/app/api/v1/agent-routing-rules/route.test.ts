import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createDbServerClient,
  createAdminClient,
  getTeamMemberFromRequest,
  getMyTeamMember,
  getAuthContext,
  requireOrgAdmin,
  requireAgentOrchestration,
  listRules,
  getRuleById,
  createRule,
  updateRule,
  replaceRules,
  reorderPriorities,
  disableRules,
  deleteRule,
} = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  createAdminClient: vi.fn(),
  getTeamMemberFromRequest: vi.fn(),
  getMyTeamMember: vi.fn(),
  getAuthContext: vi.fn(),
  requireOrgAdmin: vi.fn(),
  requireAgentOrchestration: vi.fn(),
  listRules: vi.fn(),
  getRuleById: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  replaceRules: vi.fn(),
  reorderPriorities: vi.fn(),
  disableRules: vi.fn(),
  deleteRule: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  createDbServerClient,
}));

vi.mock('@/lib/db/admin', () => ({
  createAdminClient,
}));

vi.mock('@/lib/auth-api-key', () => ({
  getTeamMemberFromRequest,
}));

vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return {
    ...actual,
    getMyTeamMember,
    getAuthContext,
  };
});

vi.mock('@/lib/admin-check', () => ({
  requireOrgAdmin,
}));

vi.mock('@/lib/require-agent-orchestration', () => ({
  requireAgentOrchestration,
}));

vi.mock('@/services/agent-routing-rule', async () => {
  const actual = await vi.importActual<typeof import('@/services/agent-routing-rule')>('@/services/agent-routing-rule');
  return {
    ...actual,
    AgentRoutingRuleService: class {
      listRules = listRules;
      getRuleById = getRuleById;
      createRule = createRule;
      updateRule = updateRule;
      replaceRules = replaceRules;
      reorderPriorities = reorderPriorities;
      disableRules = disableRules;
      deleteRule = deleteRule;
    },
  };
});

import { DELETE, GET, PATCH, POST, PUT } from './route';

describe('/api/v1/agent-routing-rules', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    createAdminClient.mockReset();
    getTeamMemberFromRequest.mockReset();
    getMyTeamMember.mockReset();
    getAuthContext.mockReset();
    requireOrgAdmin.mockReset();
    requireAgentOrchestration.mockReset();
    listRules.mockReset();
    getRuleById.mockReset();
    createRule.mockReset();
    updateRule.mockReset();
    replaceRules.mockReset();
    reorderPriorities.mockReset();
    disableRules.mockReset();
    deleteRule.mockReset();

    createAdminClient.mockReturnValue({});
    getTeamMemberFromRequest.mockResolvedValue(null); // default: no API key

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

    getAuthContext.mockResolvedValue({
      id: 'member-1',
      org_id: 'org-1',
      project_id: 'project-1',
      project_name: 'test',
      type: 'human',
    });

    requireAgentOrchestration.mockResolvedValue(null);
  });

  it('blocks workflow reads when upgrade is required', async () => {
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await GET(new Request('http://localhost/api/v1/agent-routing-rules'));

    expect(response.status).toBe(403);
    expect(listRules).not.toHaveBeenCalled();
  });

  it('lists routing rules in the current scope', async () => {
    listRules.mockResolvedValue([{ id: 'rule-1', priority: 10 }]);

    const response = await GET(new Request('http://localhost/api/v1/agent-routing-rules'));

    expect(response.status).toBe(200);
    expect(listRules).toHaveBeenCalledWith({ orgId: 'org-1', projectId: 'project-1' });
  });

  it('loads a single routing rule by id', async () => {
    getRuleById.mockResolvedValue({ id: 'rule-1', name: 'triage' });

    const response = await GET(new Request('http://localhost/api/v1/agent-routing-rules?id=rule-1'));

    expect(response.status).toBe(200);
    expect(getRuleById).toHaveBeenCalledWith('rule-1', { orgId: 'org-1', projectId: 'project-1' });
  });

  it('rejects workflow creation bypass when upgrade is required', async () => {
    requireAgentOrchestration.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await POST(new Request('http://localhost/api/v1/agent-routing-rules', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: 'agent-2',
        name: 'triage',
        action: { auto_reply_mode: 'process_and_report' },
      }),
    }));

    expect(response.status).toBe(403);
    expect(createRule).not.toHaveBeenCalled();
  });

  it('creates a routing rule', async () => {
    createRule.mockResolvedValue({ id: 'rule-1', name: 'triage' });

    const response = await POST(new Request('http://localhost/api/v1/agent-routing-rules', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: 'agent-2',
        name: 'triage',
        priority: 10,
        conditions: { memo_type: ['task'] },
        action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-3' },
      }),
    }));

    expect(response.status).toBe(201);
    expect(requireOrgAdmin).toHaveBeenCalledWith(expect.anything(), 'org-1');
    expect(createRule).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
      agent_id: 'agent-2',
      name: 'triage',
    }));
  });

  it('updates a routing rule', async () => {
    updateRule.mockResolvedValue({ id: 'rule-1', priority: 20 });

    const response = await PUT(new Request('http://localhost/api/v1/agent-routing-rules', {
      method: 'PUT',
      body: JSON.stringify({
        id: 'rule-1',
        priority: 20,
        action: { auto_reply_mode: 'process_and_report' },
      }),
    }));

    expect(response.status).toBe(200);
    expect(updateRule).toHaveBeenCalledWith('rule-1', { orgId: 'org-1', projectId: 'project-1' }, expect.objectContaining({
      actorId: 'member-1',
      id: 'rule-1',
      priority: 20,
    }));
  });

  it('rejects process_and_report rules that still carry forward_to_agent_id', async () => {
    const response = await POST(new Request('http://localhost/api/v1/agent-routing-rules', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: 'agent-2',
        name: 'invalid-contract',
        action: {
          auto_reply_mode: 'process_and_report',
          forward_to_agent_id: 'agent-3',
        },
      }),
    }));

    expect(response.status).toBe(400);
    expect(createRule).not.toHaveBeenCalled();
  });

  it('rejects process_and_forward rules without an explicit forward target', async () => {
    const response = await POST(new Request('http://localhost/api/v1/agent-routing-rules', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: 'agent-2',
        name: 'invalid-forward',
        action: {
          auto_reply_mode: 'process_and_forward',
        },
      }),
    }));

    expect(response.status).toBe(400);
    expect(createRule).not.toHaveBeenCalled();
  });

  it('rejects self-forward routing rules before save', async () => {
    const response = await PUT(new Request('http://localhost/api/v1/agent-routing-rules', {
      method: 'PUT',
      body: JSON.stringify({
        items: [
          {
            agent_id: 'agent-2',
            name: 'self-loop',
            action: {
              auto_reply_mode: 'process_and_forward',
              forward_to_agent_id: 'agent-2',
            },
          },
        ],
      }),
    }));

    expect(response.status).toBe(400);
    expect(replaceRules).not.toHaveBeenCalled();
  });

  it('replaces the workflow snapshot with one atomic batch request', async () => {
    replaceRules.mockResolvedValue([{ id: 'rule-1', priority: 10 }, { id: 'rule-2', priority: 20 }]);

    const response = await PUT(new Request('http://localhost/api/v1/agent-routing-rules', {
      method: 'PUT',
      body: JSON.stringify({
        items: [
          {
            id: 'rule-1',
            agent_id: 'agent-1',
            name: 'agent-1 -> agent-2',
            priority: 10,
            conditions: { memo_type: ['task'] },
            action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-2' },
          },
          {
            agent_id: 'agent-2',
            name: 'agent-2 -> fallback',
            priority: 20,
            conditions: { memo_type: [] },
            action: { auto_reply_mode: 'process_and_report' },
          },
        ],
      }),
    }));

    expect(response.status).toBe(200);
    expect(replaceRules).toHaveBeenCalledWith({
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
      items: [
        {
          id: 'rule-1',
          agent_id: 'agent-1',
          name: 'agent-1 -> agent-2',
          priority: 10,
          conditions: { memo_type: ['task'] },
          action: { auto_reply_mode: 'process_and_forward', forward_to_agent_id: 'agent-2' },
        },
        {
          agent_id: 'agent-2',
          name: 'agent-2 -> fallback',
          priority: 20,
          conditions: { memo_type: [] },
          action: { auto_reply_mode: 'process_and_report' },
        },
      ],
    });
    expect(updateRule).not.toHaveBeenCalled();
  });

  it('reorders priorities with patch array updates', async () => {
    reorderPriorities.mockResolvedValue([{ id: 'rule-1', priority: 5 }, { id: 'rule-2', priority: 10 }]);

    const response = await PATCH(new Request('http://localhost/api/v1/agent-routing-rules', {
      method: 'PATCH',
      body: JSON.stringify({ items: [{ id: 'rule-1', priority: 5 }, { id: 'rule-2', priority: 10 }] }),
    }));

    expect(response.status).toBe(200);
    expect(reorderPriorities).toHaveBeenCalledWith({ orgId: 'org-1', projectId: 'project-1' }, [
      { id: 'rule-1', priority: 5 },
      { id: 'rule-2', priority: 10 },
    ]);
  });


  it('disables all live routing rules with a dedicated patch action', async () => {
    disableRules.mockResolvedValue([{ id: 'rule-1', is_enabled: false }]);

    const response = await PATCH(new Request('http://localhost/api/v1/agent-routing-rules', {
      method: 'PATCH',
      body: JSON.stringify({ disable_all: true }),
    }));

    expect(response.status).toBe(200);
    expect(disableRules).toHaveBeenCalledWith({ orgId: 'org-1', projectId: 'project-1' });
    expect(reorderPriorities).not.toHaveBeenCalled();
  });

  it('deletes a routing rule by query id', async () => {
    deleteRule.mockResolvedValue({ ok: true, id: 'rule-1' });

    const response = await DELETE(new Request('http://localhost/api/v1/agent-routing-rules?id=rule-1', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(200);
    expect(deleteRule).toHaveBeenCalledWith('rule-1', { orgId: 'org-1', projectId: 'project-1' });
  });
});
