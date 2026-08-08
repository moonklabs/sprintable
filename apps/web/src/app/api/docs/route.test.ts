import { beforeEach, describe, expect, it, vi } from 'vitest';

// story #2191(#2231 규약 A) — getTree()를 소거하고 list()/search()로 통합했다. BE가
// has_more/next_cursor를 직접 계산해 body meta로 낸다(#2540) — 이 route는 그 값을 그대로
// 믿고 전달한다(buildCursorPageMeta 재추론 없음).
const { createDbServerClient, createAdminClient, getAuthContext } = vi.hoisted(() => ({
  createDbServerClient: vi.fn(),
  createAdminClient: vi.fn(),
  getAuthContext: vi.fn(),
}));
const listMock = vi.fn();
const searchMock = vi.fn();
const getDocMock = vi.fn();
const listByIdsMock = vi.fn();

vi.mock('@/lib/db/server', () => ({ createDbServerClient }));
vi.mock('@/lib/db/admin', () => ({ createAdminClient }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/services/docs', () => ({
  DocsService: class { list = listMock; search = searchMock; getDoc = getDocMock; listByIds = listByIdsMock; },
}));

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
    listMock.mockReset();
    searchMock.mockReset();
    getDocMock.mockReset();
    createDbServerClient.mockResolvedValue({});
    createAdminClient.mockReturnValue({});
    getAuthContext.mockResolvedValue(mockAuth);
  });

  it('view=tree 파라미터는 이제 죽은 값이다 — 태그 없이도 list()가 커서와 함께 호출된다(#2191)', async () => {
    listMock.mockResolvedValue({
      items: [
        { id: 'folder-1', parent_id: null, sort_order: 0 },
        { id: 'doc-1', parent_id: 'folder-1', sort_order: 1 },
      ],
      hasMore: true,
      nextCursor: '1:doc-1',
    });

    const response = await GET(new Request('http://localhost/api/docs?project_id=project-1&view=tree&limit=20'));
    const body = await response.json();

    expect(listMock).toHaveBeenCalledWith('project-1', expect.objectContaining({ limit: 20, tags: undefined }));
    expect(body.data).toHaveLength(2);
    expect(body.meta).toEqual(expect.objectContaining({ hasMore: true, nextCursor: '1:doc-1' }));
  });

  it('50건 넘는 트리에서도(가짜 재현) hasMore=true·nextCursor가 그대로 전달된다 — BE 값 재추론 없음', async () => {
    listMock.mockResolvedValue({ items: Array.from({ length: 20 }, (_, i) => ({ id: `doc-${i}` })), hasMore: true, nextCursor: '0:doc-19' });

    const response = await GET(new Request('http://localhost/api/docs?project_id=project-1&limit=20'));
    const body = await response.json();

    expect(body.data).toHaveLength(20);
    expect(body.meta.hasMore).toBe(true);
    expect(body.meta.nextCursor).toBe('0:doc-19');
  });

  it('음성대조 — hasMore=false면 nextCursor도 null로 전달된다("더 보기"가 안 서게)', async () => {
    listMock.mockResolvedValue({ items: [{ id: 'doc-1' }], hasMore: false, nextCursor: null });

    const response = await GET(new Request('http://localhost/api/docs?project_id=project-1'));
    const body = await response.json();

    expect(body.meta.hasMore).toBe(false);
    expect(body.meta.nextCursor).toBeNull();
  });

  it('tags 필터가 있으면 list()에 그대로 전달된다', async () => {
    listMock.mockResolvedValue({ items: [], hasMore: false, nextCursor: null });

    await GET(new Request('http://localhost/api/docs?project_id=project-1&tags=policy,handbook'));

    expect(listMock).toHaveBeenCalledWith('project-1', expect.objectContaining({ tags: ['policy', 'handbook'] }));
  });

  it('검색(q)은 search()를 타고, BE가 낸 hasMore/nextCursor를 그대로 반환한다', async () => {
    searchMock.mockResolvedValue({
      items: [{ id: 'doc-3', updated_at: '2026-04-13T03:00:00.000Z' }, { id: 'doc-2', updated_at: '2026-04-13T02:00:00.000Z' }],
      hasMore: false,
      nextCursor: null,
    });

    const response = await GET(new Request('http://localhost/api/docs?project_id=project-1&q=policy&limit=2'));
    const body = await response.json();

    expect(searchMock).toHaveBeenCalledWith('project-1', 'policy', expect.objectContaining({ limit: 2, cursor: null }));
    expect(body.data).toHaveLength(2);
    expect(body.meta).toEqual(expect.objectContaining({ hasMore: false, nextCursor: null }));
  });

  it('slug 단건 조회는 getDoc()을 탄다(list/search 안 거침)', async () => {
    getDocMock.mockResolvedValue({ id: 'doc-1', slug: 'my-doc' });

    const response = await GET(new Request('http://localhost/api/docs?project_id=project-1&slug=my-doc'));
    const body = await response.json();

    expect(getDocMock).toHaveBeenCalledWith('project-1', 'my-doc');
    expect(listMock).not.toHaveBeenCalled();
    expect(body.data).toEqual({ id: 'doc-1', slug: 'my-doc' });
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

// story #2262 PR②(BE #2905) — ids 배치 lookup 분기. ⛔project_id 필수 검사(다른 모든 분기의
// 전제)보다 먼저 갈라져야 한다 — org 전체에서 조회하는 게 계약이다(stories와 동일 축).
describe('GET /api/docs — ids 배치 lookup 분기(#2262 PR②)', () => {
  beforeEach(() => {
    createDbServerClient.mockReset();
    createAdminClient.mockReset();
    getAuthContext.mockReset();
    listMock.mockReset();
    listByIdsMock.mockReset();
    getAuthContext.mockResolvedValue(mockAuth);
  });

  it('project_id 없이 ids만 있어도 400이 아니라 배치 경로를 탄다(project_id 필수 검사를 우회)', async () => {
    listByIdsMock.mockResolvedValue({ items: [{ id: 'd1' }, { id: 'd2' }], hasMore: false, nextCursor: null });
    const res = await GET(new Request('http://localhost/api/docs?ids=d1,d2'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(listByIdsMock).toHaveBeenCalledWith(['d1', 'd2']);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('caps ids at 200 before calling the service', async () => {
    listByIdsMock.mockResolvedValue({ items: [], hasMore: false, nextCursor: null });
    const manyIds = Array.from({ length: 250 }, (_, i) => `id${i}`).join(',');
    await GET(new Request(`http://localhost/api/docs?ids=${manyIds}`));
    const calledWith = listByIdsMock.mock.calls[0]![0] as string[];
    expect(calledWith).toHaveLength(200);
  });

  it('no ids param → project_id required error stays intact(회귀 없음)', async () => {
    const res = await GET(new Request('http://localhost/api/docs'));
    expect(res.status).toBe(400);
    expect(listByIdsMock).not.toHaveBeenCalled();
  });
});
