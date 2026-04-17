import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createSupabaseServerClient, createSupabaseAdminClient, getAuthContext } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  getAuthContext: vi.fn(),
}));

const listMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/services/task', () => ({ TaskService: class { list = listMock; } }));

import { GET } from './route';

const mockAuth = {
  id: 'team-member-1',
  org_id: 'org-1',
  project_id: 'project-1',
  project_name: 'Test',
  type: 'human' as const,
  rateLimitExceeded: false,
};

function createCountBuilder() {
  const state: Record<string, unknown> = {};
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      state[column] = value;
      return builder;
    }),
    then: (resolve: (value: { count: number; error: null }) => unknown) => resolve({
      count: state.status === 'done' ? 3 : 7,
      error: null,
    }),
  };
  return builder;
}

describe('GET /api/tasks', () => {
  beforeEach(() => {
    listMock.mockReset();
    createSupabaseServerClient.mockReset();
    createSupabaseAdminClient.mockReset();
    getAuthContext.mockReset();

    const supabaseMock = { from: vi.fn(() => createCountBuilder()) };
    createSupabaseServerClient.mockResolvedValue(supabaseMock);
    createSupabaseAdminClient.mockReturnValue(supabaseMock);
    getAuthContext.mockResolvedValue(mockAuth);
  });

  it('returns bounded pagination metadata plus story task counts', async () => {
    listMock.mockResolvedValue([
      { id: 'task-3', created_at: '2026-04-13T03:00:00.000Z', status: 'done' },
      { id: 'task-2', created_at: '2026-04-13T02:00:00.000Z', status: 'todo' },
      { id: 'task-1', created_at: '2026-04-13T01:00:00.000Z', status: 'todo' },
    ]);

    const response = await GET(new Request('http://localhost/api/tasks?story_id=story-1&limit=2'));
    const body = await response.json();

    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({
      story_id: 'story-1',
      limit: 2,
      cursor: null,
    }));
    expect(body.data).toHaveLength(2);
    expect(body.meta).toEqual(expect.objectContaining({
      hasMore: true,
      nextCursor: '2026-04-13T02:00:00.000Z',
      totalCount: 7,
      doneCount: 3,
    }));
  });
});
