import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSupabaseServerClient,
  createSupabaseAdminClient,
  getAuthContext,
  createInboxItemRepository,
  isOssMode,
  cookies,
} = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  getAuthContext: vi.fn(),
  createInboxItemRepository: vi.fn(),
  isOssMode: vi.fn(() => false),
  cookies: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient }));
vi.mock('@/lib/auth-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-helpers')>('@/lib/auth-helpers');
  return { ...actual, getAuthContext };
});
vi.mock('@/lib/storage/factory', () => ({ createInboxItemRepository, isOssMode }));
vi.mock('next/headers', () => ({ cookies }));

import { GET } from './route';

const ME = {
  id: 'tm-1',
  org_id: 'org-1',
  project_id: 'proj-1',
  project_name: 'Proj',
  type: 'human' as const,
  rateLimitExceeded: false,
  rateLimitRemaining: 299,
  rateLimitResetAt: 0,
};

describe('GET /api/inbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isOssMode.mockReturnValue(false);
    createSupabaseServerClient.mockResolvedValue({});
    cookies.mockResolvedValue({ get: vi.fn(() => undefined) });
    getAuthContext.mockResolvedValue(ME);
  });

  it('returns 401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValueOnce(null);
    const res = await GET(new Request('http://localhost/api/inbox'));
    expect(res.status).toBe(401);
  });

  it('lists pending inbox items for the current assignee + project + org', async () => {
    const repo = {
      list: vi.fn().mockResolvedValue([
        { id: 'i1', org_id: 'org-1', kind: 'approval', state: 'pending', created_at: '2026-04-26T00:00:00Z' },
      ]),
      count: vi.fn().mockResolvedValue({
        total: 1,
        byKind: { approval: 1, decision: 0, blocker: 0, mention: 0 },
      }),
    };
    createInboxItemRepository.mockResolvedValue(repo);

    const res = await GET(new Request('http://localhost/api/inbox'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.meta.pendingCount).toBe(1);
    expect(body.meta.countsByKind.approval).toBe(1);
    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({
      org_id: 'org-1',
      project_id: 'proj-1',
      assignee_member_id: 'tm-1',
      state: 'pending',
    }));
  });

  it('rejects invalid kind', async () => {
    const repo = { list: vi.fn(), count: vi.fn() };
    createInboxItemRepository.mockResolvedValue(repo);

    const res = await GET(new Request('http://localhost/api/inbox?kind=invalid'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects invalid state', async () => {
    const repo = { list: vi.fn(), count: vi.fn() };
    createInboxItemRepository.mockResolvedValue(repo);

    const res = await GET(new Request('http://localhost/api/inbox?state=closed'));
    expect(res.status).toBe(400);
  });

  it('forwards kind filter to repo when valid', async () => {
    const repo = {
      list: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue({ total: 0, byKind: { approval: 0, decision: 0, blocker: 0, mention: 0 } }),
    };
    createInboxItemRepository.mockResolvedValue(repo);

    await GET(new Request('http://localhost/api/inbox?kind=blocker'));
    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ kind: 'blocker' }));
  });

  it('uses cookie project_id when present', async () => {
    cookies.mockResolvedValue({
      get: vi.fn((name: string) => (name === 'sprintable_current_project_id' ? { value: 'cookie-proj' } : undefined)),
    });
    const repo = {
      list: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue({ total: 0, byKind: { approval: 0, decision: 0, blocker: 0, mention: 0 } }),
    };
    createInboxItemRepository.mockResolvedValue(repo);

    await GET(new Request('http://localhost/api/inbox'));
    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'cookie-proj' }));
  });

  it('OSS mode skips dbClient and uses local repo', async () => {
    isOssMode.mockReturnValue(true);
    const repo = {
      list: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue({ total: 0, byKind: { approval: 0, decision: 0, blocker: 0, mention: 0 } }),
    };
    createInboxItemRepository.mockResolvedValue(repo);

    const res = await GET(new Request('http://localhost/api/inbox'));
    expect(res.status).toBe(200);
    expect(createInboxItemRepository).toHaveBeenCalledWith(undefined);
  });
});
