import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  createDbServerClientMock,
  createAdminClientMock,
  getMyTeamMemberMock,
  requireOrgAdminMock,
  requireAgentOrchestrationMock,
  transitionSessionMock,
  resumeSessionCandidatesMock,
} = vi.hoisted(() => ({
  createDbServerClientMock: vi.fn(),
  createAdminClientMock: vi.fn(),
  getMyTeamMemberMock: vi.fn(),
  requireOrgAdminMock: vi.fn(),
  requireAgentOrchestrationMock: vi.fn(),
  transitionSessionMock: vi.fn(),
  resumeSessionCandidatesMock: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  createDbServerClient: createDbServerClientMock,
}));

vi.mock('@/lib/db/admin', () => ({
  createAdminClient: createAdminClientMock,
}));

vi.mock('@/lib/auth-helpers', () => ({
  getMyTeamMember: getMyTeamMemberMock,
}));

vi.mock('@/lib/admin-check', () => ({
  requireOrgAdmin: requireOrgAdminMock,
}));

vi.mock('@/lib/require-agent-orchestration', () => ({
  requireAgentOrchestration: requireAgentOrchestrationMock,
}));

vi.mock('@/services/agent-session-lifecycle', () => ({
  AgentSessionLifecycleError: class extends Error {
    constructor(public readonly code: string, public readonly status: number, message: string) {
      super(message);
    }
  },
  AgentSessionLifecycleService: class {
    transitionSession = transitionSessionMock;
  },
}));

vi.mock('@/services/agent-session-resume', () => ({
  resumeSessionCandidates: resumeSessionCandidatesMock,
}));

import { PATCH } from './route';

describe('PATCH /api/v1/agent-sessions/[id]', () => {
  beforeEach(() => {
    createDbServerClientMock.mockReset();
    createAdminClientMock.mockReset();
    getMyTeamMemberMock.mockReset();
    requireOrgAdminMock.mockReset();
    requireAgentOrchestrationMock.mockReset();
    transitionSessionMock.mockReset();
    resumeSessionCandidatesMock.mockReset();

    createDbServerClientMock.mockResolvedValue({
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
    });
    createAdminClientMock.mockReturnValue({ tag: 'admin-db' });
    getMyTeamMemberMock.mockResolvedValue({ id: 'member-1', org_id: 'org-1', project_id: 'project-1' });
    requireOrgAdminMock.mockResolvedValue(undefined);
    requireAgentOrchestrationMock.mockResolvedValue(null);
    transitionSessionMock.mockResolvedValue({
      session: { id: 'session-1', status: 'suspended' },
      resumptions: [],
    });
  });

  it('blocks session transition bypass when upgrade is required', async () => {
    requireAgentOrchestrationMock.mockResolvedValue(new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      error: { code: 'UPGRADE_REQUIRED', message: 'Upgrade required' },
    }), { status: 403, headers: { 'Content-Type': 'application/json' } }));

    const response = await PATCH(
      new Request('http://localhost:3108/api/v1/agent-sessions/session-1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'suspended', reason: 'manual_pause' }),
      }),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(response.status).toBe(403);
    expect(transitionSessionMock).not.toHaveBeenCalled();
  });

  it('transitions a session for project admins', async () => {
    const response = await PATCH(
      new Request('http://localhost:3108/api/v1/agent-sessions/session-1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'suspended', reason: 'manual_pause' }),
      }),
      { params: Promise.resolve({ id: 'session-1' }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(requireAgentOrchestrationMock).toHaveBeenCalledWith(expect.anything(), 'org-1');
    expect(transitionSessionMock).toHaveBeenCalledWith({
      sessionId: 'session-1',
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
      status: 'suspended',
      reason: 'manual_pause',
    });
    expect(payload.data.session).toEqual({ id: 'session-1', status: 'suspended' });
    expect(resumeSessionCandidatesMock).not.toHaveBeenCalled();
  });

  it('resumes held runs when a suspended session is manually reactivated', async () => {
    transitionSessionMock.mockResolvedValue({
      session: { id: 'session-1', status: 'active' },
      resumptions: [{ runId: 'run-1', memoId: 'memo-1', orgId: 'org-1', projectId: 'project-1', agentId: 'agent-1' }],
    });

    const response = await PATCH(
      new Request('http://localhost:3108/api/v1/agent-sessions/session-1', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active', reason: 'resume' }),
      }),
      { params: Promise.resolve({ id: 'session-1' }) },
    );

    expect(response.status).toBe(200);
    expect(resumeSessionCandidatesMock).toHaveBeenCalledWith({ tag: 'admin-db' }, [
      { runId: 'run-1', memoId: 'memo-1', orgId: 'org-1', projectId: 'project-1', agentId: 'agent-1' },
    ]);
  });
});
