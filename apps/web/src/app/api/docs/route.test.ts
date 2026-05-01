import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbServerClient, createAdminClient, getAuthContext } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  createAdminClient: vi.fn(),
  getAuthContext: vi.fn(),
}));
const getTreeMock = vi.fn();
const listMock = vi.fn();
const searchMock = vi.fn();
const getDocMock = vi.fn();

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/services/docs', () => ({ DocsService: class { getTree = getTreeMock; list = listMock; search = searchMock; getDoc = getDocMock; } }));

import { GET } from './route';

const mockAuth = {
  id: 'team-member-1',
  org_id: 'org-1',
  project_id: 'project-1',
  project_name: 'Test',
  type: 'human' as const,
  rateLimitExceeded: false,
};

describe('GET /api/docs', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    createAdminClient.mockReset();
    getAuthContext.mockReset();
    getTreeMock.mockReset();
    listMock.mockReset();
    searchMock.mockReset();
    getDocMock.mockReset();
    createDbServerClient.mockResolvedValue({});
    createAdminClient.mockReturnValue({});
    getAuthContext.mockResolvedValue(mockAuth);
  });

  it('returns hierarchy-preserving tree data when view=tree is requested', async () => {
    getTreeMock.mockResolvedValue([
      { id: 'folder-1', parent_id: null, sort_order: 0 },
      { id: 'doc-1', parent_id: 'folder-1', sort_order: 1 },
    ]);

    const response = await GET(new Request('http://localhost/api/docs?project_id=project-1&view=tree'));
    const body = await response.json();

    expect(getTreeMock).toHaveBeenCalledWith('project-1');
    expect(listMock).not.toHaveBeenCalled();
    expect(body.meta).toEqual(expect.objectContaining({ mode: 'tree', exception: 'hierarchy_preserving_tree_browse' }));
  });

  it('paginates search results with updated_at cursor metadata', async () => {
    searchMock.mockResolvedValue([
      { id: 'doc-3', updated_at: '2026-04-13T03:00:00.000Z' },
      { id: 'doc-2', updated_at: '2026-04-13T02:00:00.000Z' },
      { id: 'doc-1', updated_at: '2026-04-13T01:00:00.000Z' },
    ]);

    const response = await GET(new Request('http://localhost/api/docs?project_id=project-1&q=policy&limit=2'));
    const body = await response.json();

    expect(searchMock).toHaveBeenCalledWith('project-1', 'policy', expect.objectContaining({ limit: 2, cursor: null }));
    expect(body.data).toHaveLength(2);
    expect(body.meta).toEqual(expect.objectContaining({ hasMore: true, nextCursor: '2026-04-13T02:00:00.000Z' }));
  });

  it('returns 401 when not authenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    const response = await GET(new Request('http://localhost/api/docs?project_id=project-1'));
    expect(response.status).toBe(401);
  });

  it('returns 429 when rate limit exceeded', async () => {
    getAuthContext.mockResolvedValue({ ...mockAuth, rateLimitExceeded: true, rateLimitRemaining: 0, rateLimitResetAt: 9999 });
    const response = await GET(new Request('http://localhost/api/docs?project_id=project-1'));
    expect(response.status).toBe(429);
  });
});
