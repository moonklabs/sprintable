import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbServerClient } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
}));

const { getAuthContext } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
}));

const { createAdminClient } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
}));

const getByIdWithDetailsMock = vi.fn();

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/services/memo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/memo')>();
  return {
    ...actual,
    MemoService: class { getByIdWithDetails = getByIdWithDetailsMock; },
  };
});

import { GET } from './route';

describe('GET /api/memos/[id]', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    getAuthContext.mockReset();
    createAdminClient.mockReset();
    getByIdWithDetailsMock.mockReset();
    createDbServerClient.mockResolvedValue({});
    createAdminClient.mockReturnValue({});
  });

  it('returns 401 when no auth context', async () => {
    getAuthContext.mockResolvedValue(null);

    const response = await GET(
      new Request('http://localhost/api/memos/memo-1'),
      { params: Promise.resolve({ id: 'memo-1' }) }
    );

    expect(response.status).toBe(401);
  });

  it('returns 429 when rate limit exceeded', async () => {
    getAuthContext.mockResolvedValue({
      id: 'agent-1',
      org_id: 'org-1',
      project_id: 'project-1',
      project_name: 'Test Project',
      type: 'agent',
      rateLimitExceeded: true,
      rateLimitRemaining: 0,
      rateLimitResetAt: Date.now() + 60000,
    });

    const response = await GET(
      new Request('http://localhost/api/memos/memo-1'),
      { params: Promise.resolve({ id: 'memo-1' }) }
    );

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toBe('Rate limit exceeded');
  });

  it('uses admin client for agent auth', async () => {
    getAuthContext.mockResolvedValue({
      id: 'agent-1',
      org_id: 'org-1',
      project_id: 'project-1',
      project_name: 'Test Project',
      type: 'agent',
      rateLimitExceeded: false,
    });

    const mockAdminClient = { admin: true };
    createAdminClient.mockReturnValue(mockAdminClient);
    getByIdWithDetailsMock.mockResolvedValue({ id: 'memo-1', content: 'Test Memo', project_id: 'project-1' });

    await GET(
      new Request('http://localhost/api/memos/memo-1'),
      { params: Promise.resolve({ id: 'memo-1' }) }
    );

    expect(createAdminClient).toHaveBeenCalled();
    expect(getByIdWithDetailsMock).toHaveBeenCalled();
  });

  it('uses server client for human auth', async () => {
    getAuthContext.mockResolvedValue({
      id: 'member-1',
      org_id: 'org-1',
      project_id: 'project-1',
      project_name: 'Test Project',
      type: 'human',
    });

    const mockServerClient = { server: true };
    createDbServerClient.mockResolvedValue(mockServerClient);
    getByIdWithDetailsMock.mockResolvedValue({ id: 'memo-1', content: 'Test Memo', project_id: 'project-1' });

    await GET(
      new Request('http://localhost/api/memos/memo-1'),
      { params: Promise.resolve({ id: 'memo-1' }) }
    );

    expect(createAdminClient).not.toHaveBeenCalled();
    expect(getByIdWithDetailsMock).toHaveBeenCalled();
  });

  it('returns memo data on success', async () => {
    getAuthContext.mockResolvedValue({
      id: 'member-1',
      org_id: 'org-1',
      project_id: 'project-1',
      project_name: 'Test Project',
      type: 'human',
    });

    const mockMemo = { id: 'memo-1', content: 'Test Memo', project_id: 'project-1' };
    getByIdWithDetailsMock.mockResolvedValue(mockMemo);

    const response = await GET(
      new Request('http://localhost/api/memos/memo-1'),
      { params: Promise.resolve({ id: 'memo-1' }) }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(mockMemo);
  });

  it('returns 403 when agent tries to access cross-project memo', async () => {
    getAuthContext.mockResolvedValue({
      id: 'agent-1',
      org_id: 'org-1',
      project_id: 'project-1',
      project_name: 'Test Project',
      type: 'agent',
      rateLimitExceeded: false,
    });

    const mockAdminClient = { admin: true };
    createAdminClient.mockReturnValue(mockAdminClient);
    // Memo belongs to different project
    getByIdWithDetailsMock.mockResolvedValue({
      id: 'memo-2',
      content: 'Other Project Memo',
      project_id: 'project-2',
    });

    const response = await GET(
      new Request('http://localhost/api/memos/memo-2'),
      { params: Promise.resolve({ id: 'memo-2' }) }
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.message).toContain('cross-project');
  });

  it('allows agent to access same-project memo', async () => {
    getAuthContext.mockResolvedValue({
      id: 'agent-1',
      org_id: 'org-1',
      project_id: 'project-1',
      project_name: 'Test Project',
      type: 'agent',
      rateLimitExceeded: false,
    });

    const mockAdminClient = { admin: true };
    createAdminClient.mockReturnValue(mockAdminClient);
    getByIdWithDetailsMock.mockResolvedValue({
      id: 'memo-1',
      content: 'Same Project Memo',
      project_id: 'project-1',
    });

    const response = await GET(
      new Request('http://localhost/api/memos/memo-1'),
      { params: Promise.resolve({ id: 'memo-1' }) }
    );

    expect(response.status).toBe(200);
  });
});
