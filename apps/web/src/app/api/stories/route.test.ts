import { beforeEach, describe, expect, it, vi } from 'vitest';

// story ca37b2b0 — GET ids 배치 lookup(BE #2131) 분기 회귀가드. StoryService.list()를
// 목킹해 (a) ids 없으면 기존 커서 페이지네이션 경로 (b) ids 있으면 meta 없는 배치 응답
// (c) 200개 cap 방어 (d) 빈/공백 ids는 무시하고 기존 경로로 폴백을 검증한다.
const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(), createStoryRepository: vi.fn(), list: vi.fn(), proxyToFastapi: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext: h.getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createStoryRepository: h.createStoryRepository }));
vi.mock('@/services/story', async (importActual) => ({
  ...(await importActual<typeof import('@/services/story')>()),
  StoryService: class { list = h.list; },
}));
// story #2534 카디르 QA HIGH fix — unattached=true 분기는 StoryService를 안 거치고
// proxyToFastapi로 raw 통과(backlog route와 동형) — X-Total-Count 헤더 forwarding 검증용 목.
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: h.proxyToFastapi }));

import { GET } from './route';

const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const story = (id: string) => ({ id, title: `Story ${id}`, created_at: '2026-07-01T00:00:00Z' });

describe('/api/stories GET — ids 배치 lookup 분기', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createStoryRepository.mockResolvedValue({});
  });

  it('401 when unauthenticated', async () => {
    h.getAuthContext.mockResolvedValue(null);
    expect((await GET(new Request('http://localhost/api/stories?ids=s1'))).status).toBe(401);
    expect(h.list).not.toHaveBeenCalled();
  });

  it('no ids param → existing cursor-paginated path (limit+1 overfetch·meta present, no ids key sent)', async () => {
    h.list.mockResolvedValue([story('1'), story('2')]);
    const res = await GET(new Request('http://localhost/api/stories?project_id=p'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta).toBeTruthy();
    const calledWith = h.list.mock.calls[0]![0] as { ids?: string[]; limit?: number };
    expect(calledWith.ids).toBeUndefined();
    expect(calledWith.limit).toBe(51); // RC3 overfetch(default 50 + 1)
  });

  it('ids param present → batch lookup, no pagination meta, ids forwarded verbatim', async () => {
    h.list.mockResolvedValue([story('a1'), story('a2')]);
    const res = await GET(new Request('http://localhost/api/stories?project_id=p&ids=a1,a2'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.meta).toBeFalsy(); // apiSuccess(stories) — 두번째 인자 생략, meta=null 직렬화
    expect(h.list).toHaveBeenCalledWith({ project_id: 'p', ids: ['a1', 'a2'], limit: 2 });
  });

  it('caps ids at 200 before calling the service (BE 200개 cap 방어, 422 회피)', async () => {
    h.list.mockResolvedValue([]);
    const manyIds = Array.from({ length: 250 }, (_, i) => `id${i}`).join(',');
    await GET(new Request(`http://localhost/api/stories?ids=${manyIds}`));
    const calledWith = h.list.mock.calls[0]![0] as { ids: string[] };
    expect(calledWith.ids).toHaveLength(200);
  });

  it('blank/empty ids param falls back to the normal paginated path (no-fiction — 빈 배치를 쏘지 않음)', async () => {
    h.list.mockResolvedValue([]);
    await GET(new Request('http://localhost/api/stories?ids=  ,  '));
    const calledWith = h.list.mock.calls[0]![0] as { ids?: string[] };
    expect(calledWith.ids).toBeUndefined();
  });
});

describe('/api/stories GET — unattached=true 분기(story #2534, 카디르 QA HIGH fix)', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createStoryRepository.mockResolvedValue({});
  });

  it('StoryService를 안 거치고 raw proxy로 통과하며, X-Total-Count 헤더를 meta.total로 옮긴다', async () => {
    h.proxyToFastapi.mockResolvedValue(new Response(
      JSON.stringify([story('1')]),
      { status: 200, headers: { 'x-total-count': '2180' } },
    ));
    const res = await GET(new Request('http://localhost/api/stories?project_id=p&unattached=true&limit=100'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.total).toBe(2180);
    expect(body.data).toHaveLength(1);
    // StoryService.list()가 이 분기에서 호출되지 않는다(raw proxy 경로).
    expect(h.list).not.toHaveBeenCalled();
  });

  it('X-Total-Count 헤더가 없으면(예외 상황) meta.total을 안 지어낸다(meta=null)', async () => {
    h.proxyToFastapi.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const res = await GET(new Request('http://localhost/api/stories?project_id=p&unattached=true'));
    const body = await res.json();
    expect(body.meta).toBeNull();
  });

  it('BE 에러 응답이면 그대로 통과시킨다(200 아닌 응답 삼키지 않음)', async () => {
    h.proxyToFastapi.mockResolvedValue(new Response('boom', { status: 500 }));
    const res = await GET(new Request('http://localhost/api/stories?project_id=p&unattached=true'));
    expect(res.status).toBe(500);
  });
});
