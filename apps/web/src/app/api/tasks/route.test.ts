import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createDbServerClient, createAdminClient, getAuthContext, createTaskRepository, isOssMode } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  createAdminClient: vi.fn(),
  getAuthContext: vi.fn(),
  createTaskRepository: vi.fn(),
  isOssMode: vi.fn().mockReturnValue(false),
}));

const listMock = vi.fn();

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createTaskRepository, isOssMode }));
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
    createDbServerClient.mockReset();
    createAdminClient.mockReset();
    getAuthContext.mockReset();
    createTaskRepository.mockReset();
    isOssMode.mockReturnValue(false);

    const dbMock = { from: vi.fn(() => createCountBuilder()) };
    createDbServerClient.mockResolvedValue(dbMock);
    createAdminClient.mockReturnValue(dbMock);
    getAuthContext.mockResolvedValue(mockAuth);
    createTaskRepository.mockResolvedValue({});
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

  it('uses repository-backed counts in OSS mode', async () => {
    isOssMode.mockReturnValue(true);
    listMock.mockImplementation(async (filters?: { story_id?: string; status?: string; limit?: number; cursor?: string | null }) => {
      if (filters?.story_id !== 'story-1') return [];
      if (filters?.status === 'done') {
        return [
          { id: 'task-3', created_at: '2026-04-13T03:00:00.000Z', status: 'done' },
          { id: 'task-2', created_at: '2026-04-13T02:00:00.000Z', status: 'done' },
        ];
      }
      if (filters?.limit === 2) {
        return [
          { id: 'task-4', created_at: '2026-04-13T04:00:00.000Z', status: 'todo' },
          { id: 'task-3', created_at: '2026-04-13T03:00:00.000Z', status: 'done' },
          { id: 'task-2', created_at: '2026-04-13T02:00:00.000Z', status: 'done' },
        ];
      }
      return [
        { id: 'task-4', created_at: '2026-04-13T04:00:00.000Z', status: 'todo' },
        { id: 'task-3', created_at: '2026-04-13T03:00:00.000Z', status: 'done' },
        { id: 'task-2', created_at: '2026-04-13T02:00:00.000Z', status: 'done' },
        { id: 'task-1', created_at: '2026-04-13T01:00:00.000Z', status: 'todo' },
      ];
    });

    const response = await GET(new Request('http://localhost/api/tasks?story_id=story-1&limit=2'));
    const body = await response.json();

    expect(body.data).toHaveLength(2);
    expect(body.meta).toEqual(expect.objectContaining({
      hasMore: true,
      nextCursor: '2026-04-13T03:00:00.000Z',
      totalCount: 4,
      doneCount: 2,
    }));
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({
      story_id: 'story-1',
      status: 'done',
    }));
  });
});
