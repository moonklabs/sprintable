import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
}));

const { getAuthContext } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
}));

const listMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/services/memo', () => ({ MemoService: class { list = listMock; } }));

import { GET } from './route';

describe('GET /api/memos', () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
    getAuthContext.mockReset();
    listMock.mockReset();
    createSupabaseServerClient.mockResolvedValue({});
    getAuthContext.mockResolvedValue({
      id: 'member-1',
      org_id: 'org-1',
      project_id: 'project-1',
      project_name: 'Test Project',
      type: 'human',
    });
  });

  it('returns bounded cursor pagination metadata', async () => {
    listMock.mockResolvedValue([
      { id: 'memo-3', created_at: '2026-04-13T03:00:00.000Z' },
      { id: 'memo-2', created_at: '2026-04-13T02:00:00.000Z' },
      { id: 'memo-1', created_at: '2026-04-13T01:00:00.000Z' },
    ]);

    const response = await GET(new Request('http://localhost/api/memos?project_id=project-1&limit=2&cursor=2026-04-12T00:00:00.000Z&q=hello'));
    const body = await response.json();

    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1',
      q: 'hello',
      limit: 2,
      cursor: '2026-04-12T00:00:00.000Z',
    }));
    expect(body.data).toHaveLength(2);
    expect(body.meta).toEqual(expect.objectContaining({ hasMore: true, nextCursor: '2026-04-13T02:00:00.000Z', limit: 2 }));
  });
});
