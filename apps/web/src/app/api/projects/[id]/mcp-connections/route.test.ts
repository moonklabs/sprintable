import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSupabaseServerClientMock,
  createSupabaseAdminClientMock,
  getMyTeamMemberMock,
  requireOrgAdminMock,
  listProjectMcpConnectionSummariesMock,
  createMcpConnectionReviewRequestMock,
} = vi.hoisted(() => ({
  createSupabaseServerClientMock: vi.fn(),
  createSupabaseAdminClientMock: vi.fn(() => ({ tag: 'admin' })),
  getMyTeamMemberMock: vi.fn(),
  requireOrgAdminMock: vi.fn(),
  listProjectMcpConnectionSummariesMock: vi.fn(),
  createMcpConnectionReviewRequestMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: createSupabaseServerClientMock,
}));

vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: createSupabaseAdminClientMock,
}));

vi.mock('@/lib/auth-helpers', () => ({
  getMyTeamMember: getMyTeamMemberMock,
}));

vi.mock('@/lib/admin-check', () => ({
  requireOrgAdmin: requireOrgAdminMock,
}));

vi.mock('@/services/project-mcp', () => ({
  listProjectMcpConnectionSummaries: listProjectMcpConnectionSummariesMock,
  createMcpConnectionReviewRequest: createMcpConnectionReviewRequestMock,
}));

import { GET, POST } from './route';

function createSupabaseStub() {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })),
    },
  };
}

describe('project mcp connections route', () => {
  beforeEach(() => {
    createSupabaseServerClientMock.mockReset();
    createSupabaseAdminClientMock.mockClear();
    getMyTeamMemberMock.mockReset();
    requireOrgAdminMock.mockReset();
    listProjectMcpConnectionSummariesMock.mockReset();
    createMcpConnectionReviewRequestMock.mockReset();

    createSupabaseServerClientMock.mockResolvedValue(createSupabaseStub());
    getMyTeamMemberMock.mockResolvedValue({ id: 'member-1', org_id: 'org-1', project_id: 'project-1' });
    requireOrgAdminMock.mockResolvedValue(undefined);
  });

  it('returns approved connection summaries for the current project', async () => {
    listProjectMcpConnectionSummariesMock.mockResolvedValue([
      {
        serverKey: 'github',
        displayName: 'GitHub',
        provider: 'github',
        authStrategy: 'oauth',
        connected: true,
        connectUrl: 'https://github.com/login/oauth/authorize?...',
        maskedSecret: '****1234',
        label: 'octocat',
        status: 'active',
        toolNames: ['github.list_issues'],
        validatedAt: '2026-04-09T00:00:00.000Z',
        lastError: null,
      },
    ]);

    const response = await GET(new Request('https://sprintable.app/api/projects/project-1/mcp-connections'), {
      params: Promise.resolve({ id: 'project-1' }),
    });
    expect(response).toBeDefined();
    const body = await response!.json();

    expect(response!.status).toBe(200);
    expect(listProjectMcpConnectionSummariesMock).toHaveBeenCalledWith({ tag: 'admin' }, {
      orgId: 'org-1',
      projectId: 'project-1',
      origin: 'https://sprintable.app',
      actorId: 'member-1',
    });
    expect(body.data.connections).toHaveLength(1);
  });

  it('creates a custom review request', async () => {
    createMcpConnectionReviewRequestMock.mockResolvedValue({ id: 'request-1', status: 'pending' });

    const response = await POST(new Request('https://sprintable.app/api/projects/project-1/mcp-connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server_name: 'Custom Internal MCP',
        server_url: 'https://mcp.example.com/rpc',
        notes: 'Need manual review',
      }),
    }), {
      params: Promise.resolve({ id: 'project-1' }),
    });
    expect(response).toBeDefined();
    const body = await response!.json();

    expect(response!.status).toBe(201);
    expect(createMcpConnectionReviewRequestMock).toHaveBeenCalledWith({ tag: 'admin' }, {
      orgId: 'org-1',
      projectId: 'project-1',
      actorId: 'member-1',
      serverName: 'Custom Internal MCP',
      serverUrl: 'https://mcp.example.com/rpc',
      notes: 'Need manual review',
    });
    expect(body.data.id).toBe('request-1');
  });
});
