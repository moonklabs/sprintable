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

// story #3160(#3148 라이브 대조 중 PO 발견) — no_sprint=true도 unattached와 동형으로 raw
// proxy 조기분기를 타야 한다(BE list_backlog 분기는 cursor 미지원·X-Total-Count 계약이라
// 아래 cursor 페이지네이션 가정과 안 맞음). exclude_status는 cursor 경로(일반 service.list)
// 에도 화이트리스트로 추가돼 있어야 한다(«화이트리스트 유지+3자리 추가» PO 판정).
describe('/api/stories GET — no_sprint=true 분기 라우팅(story #3160)', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createStoryRepository.mockResolvedValue({});
  });

  it('no_sprint=true는 unattached와 동형으로 raw proxy를 탄다(StoryService 미호출)', async () => {
    h.proxyToFastapi.mockResolvedValue(new Response(
      JSON.stringify([story('1')]),
      { status: 200, headers: { 'x-total-count': '9' } },
    ));
    const res = await GET(new Request('http://localhost/api/stories?project_id=p&no_sprint=true&exclude_status=done,in-review'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.total).toBe(9);
    expect(h.list).not.toHaveBeenCalled();
    // raw proxy는 원본 쿼리스트링을 그대로 전달(fastapi-proxy.ts url.search) — exclude_status가
    // 이 분기에선 화이트리스트 없이 이미 통과한다는 것을 호출 인자로 확인.
    expect(h.proxyToFastapi).toHaveBeenCalledWith(expect.any(Request), '/api/v2/stories');
    const forwardedUrl = (h.proxyToFastapi.mock.calls[0]![0] as Request).url;
    expect(forwardedUrl).toContain('no_sprint=true');
    expect(forwardedUrl).toContain('exclude_status=done,in-review');
  });
});

describe('/api/stories GET — exclude_status 화이트리스트 전달(cursor 경로, story #3148/#3160)', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createStoryRepository.mockResolvedValue({});
  });

  it('exclude_status가 (no_sprint 없이도) StoryService.list()에 전달된다 — 프록시가 삼키지 않는다', async () => {
    h.list.mockResolvedValue([story('1')]);
    await GET(new Request('http://localhost/api/stories?project_id=p&exclude_status=done'));
    const calledWith = h.list.mock.calls[0]![0] as { exclude_status?: string };
    expect(calledWith.exclude_status).toBe('done');
  });

  it('exclude_status 미지정이면 undefined로 넘어간다(지어내지 않음, 회귀 0)', async () => {
    h.list.mockResolvedValue([story('1')]);
    await GET(new Request('http://localhost/api/stories?project_id=p'));
    const calledWith = h.list.mock.calls[0]![0] as { exclude_status?: string };
    expect(calledWith.exclude_status).toBeUndefined();
  });
});
