import { beforeEach, describe, expect, it, vi } from 'vitest';

// 결함 fix(2026-07-30) — `include` searchParam이 GET 핸들러에서 GoalService.list()로 한 번도
// 전달되지 않았다(story #2298/#2303의 `include=glance` 옵트인이 이 지점에서부터 이미 죽어
// 있었다 — #2224 초점 스트립 결함의 진짜 근본). ca37b2b0(stories route)와 같은 패턴으로
// GoalService.list()를 목킹해 실제로 전달되는 filters 객체를 직접 검증한다.
const h = vi.hoisted(() => ({
  getAuthContext: vi.fn(), createGoalRepository: vi.fn(), list: vi.fn(), proxyToFastapi: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext: h.getAuthContext }));
vi.mock('@/lib/storage/factory', () => ({ createGoalRepository: h.createGoalRepository }));
vi.mock('@/services/goal', async (importActual) => ({
  ...(await importActual<typeof import('@/services/goal')>()),
  GoalService: class { list = h.list; },
}));
// story #3705 — position 모드가 X-Total-Count 헤더를 읽어야 해서 service.list()/fastapiCall
// (헤더를 버림) 대신 backlog/route.ts와 동형으로 proxyToFastapi 직행으로 바뀌었다.
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi: h.proxyToFastapi }));

import { GET } from './route';

const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });

function fastapiOk(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
}

describe('/api/goals GET — include(story #2298 glance 옵트인) forwarding', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createGoalRepository.mockResolvedValue({});
    h.list.mockResolvedValue([]);
    h.proxyToFastapi.mockResolvedValue(fastapiOk([], { 'x-total-count': '0' }));
  });

  // story #3705 — position 모드는 이제 GoalService.list()가 아니라 proxyToFastapi로 나간다
  // (X-Total-Count 헤더 접근 필요, 아래 route.ts 코멘트 참고). 이 테스트가 지키던 진짜 계약
  // ("include=glance가 BE까지 도달하는가")은 그대로이므로, 관측 지점만 새 호출부로 옮긴다.
  it('forwards include=glance from the query string to the upstream proxy call', async () => {
    await GET(new Request('http://localhost/api/goals?project_id=p&order_by=position&include=glance'));

    const [upstreamRequest] = h.proxyToFastapi.mock.calls[0]! as [Request, string];
    expect(new URL(upstreamRequest.url).searchParams.get('include')).toBe('glance');
  });

  it('omits include when the query string has none(기존 무옵션 호출 byte-identical 유지)', async () => {
    await GET(new Request('http://localhost/api/goals?project_id=p'));

    const calledWith = h.list.mock.calls[0]![0] as { include?: string };
    expect(calledWith.include).toBeUndefined();
  });
});

// story #3705 — position 모드가 예전엔 `hasMore: false`를 하드코딩해 에픽이 limit을 넘는
// 프로젝트에서 "받은 게 전부"라고 단정했다(glance 아크 >100건 조용히 잘림의 근본). BE
// X-Total-Count를 읽어 진짜 총계·hasMore를 낸다.
describe('/api/goals GET — position 모드 완결성 정직화(story #3705)', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createGoalRepository.mockResolvedValue({});
  });

  it('에픽 150건·limit=100 — meta.totalCount=150·hasMore=true(되돌리면 실패)', async () => {
    const epics = Array.from({ length: 100 }, (_, i) => ({ id: `e${i}` }));
    h.proxyToFastapi.mockResolvedValue(fastapiOk(epics, { 'x-total-count': '150' }));

    const res = await GET(new Request('http://localhost/api/goals?project_id=p&order_by=position&limit=100'));
    const body = await res.json();

    expect(body.meta.totalCount).toBe(150);
    expect(body.meta.hasMore).toBe(true);
    expect(body.data).toHaveLength(100);
  });

  it('에픽 40건·limit=100(전량 로드) — hasMore=false(무회귀)', async () => {
    const epics = Array.from({ length: 40 }, (_, i) => ({ id: `e${i}` }));
    h.proxyToFastapi.mockResolvedValue(fastapiOk(epics, { 'x-total-count': '40' }));

    const res = await GET(new Request('http://localhost/api/goals?project_id=p&order_by=position&limit=100'));
    const body = await res.json();

    expect(body.meta.totalCount).toBe(40);
    expect(body.meta.hasMore).toBe(false);
  });

  it('X-Total-Count 헤더가 없으면(계약 위반) totalCount=null·hasMore=null — false로 위장하지 않는다', async () => {
    h.proxyToFastapi.mockResolvedValue(fastapiOk([{ id: 'e0' }])); // 헤더 없음

    const res = await GET(new Request('http://localhost/api/goals?project_id=p&order_by=position&limit=100'));
    const body = await res.json();

    expect(body.meta.totalCount).toBeNull();
    expect(body.meta.hasMore).toBeNull();
  });

  // 유나 design CHANGES①(PR #4059) — Number("abc")=NaN인데 `NaN === null`은 거짓이라
  // 이 갈래를 놓치면 `hasMore=epics.length<NaN`이 false로 떨어지고, NaN은 JSON
  // 직렬화에서 null이 돼 `{totalCount:null, hasMore:false}`("모르는데 확실하다")라는
  // 성립 불가 봉투가 나간다. 헤더 없음(위 테스트)과 별개로, 있지만 숫자가 아닌 경우도 pin.
  it('X-Total-Count 헤더가 숫자가 아니면(계약 위반) totalCount=null·hasMore=null(NaN이 false로 새지 않는다)', async () => {
    h.proxyToFastapi.mockResolvedValue(fastapiOk([{ id: 'e0' }], { 'x-total-count': 'abc' }));

    const res = await GET(new Request('http://localhost/api/goals?project_id=p&order_by=position&limit=100'));
    const body = await res.json();

    expect(body.meta.totalCount).toBeNull();
    expect(body.meta.hasMore).toBeNull();
  });

  it('limit을 요청 limit(≤100)으로 클램프해 업스트림에 보낸다(무제한 limit 우회 방지)', async () => {
    h.proxyToFastapi.mockResolvedValue(fastapiOk([], { 'x-total-count': '0' }));

    await GET(new Request('http://localhost/api/goals?project_id=p&order_by=position&limit=99999'));

    const [upstreamRequest] = h.proxyToFastapi.mock.calls[0]! as [Request, string];
    expect(new URL(upstreamRequest.url).searchParams.get('limit')).toBe('100');
  });
});

// story #2262 PR②(BE #2905) — ids 배치 lookup 분기. stories/route.test.ts(ca37b2b0)와
// 동일한 회귀가드 패턴 — project_id 없이도 배치 경로를 타는지가 핵심(다른 축이라는 것을
// 값으로 고정한다).
describe('/api/goals GET — ids 배치 lookup 분기(#2262 PR②)', () => {
  beforeEach(() => {
    Object.values(h).forEach((m) => m.mockReset());
    h.getAuthContext.mockResolvedValue(agent());
    h.createGoalRepository.mockResolvedValue({});
  });

  it('no ids param → existing cursor-paginated path, ids not sent', async () => {
    h.list.mockResolvedValue([]);
    await GET(new Request('http://localhost/api/goals?project_id=p'));
    const calledWith = h.list.mock.calls[0]![0] as { ids?: string[] };
    expect(calledWith.ids).toBeUndefined();
  });

  it('ids param present → batch lookup WITHOUT project_id, ids forwarded verbatim', async () => {
    h.list.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }]);
    const res = await GET(new Request('http://localhost/api/goals?ids=e1,e2'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(h.list).toHaveBeenCalledWith({ ids: ['e1', 'e2'], limit: 2 });
  });

  it('caps ids at 200 before calling the service(BE 200개 cap 방어, 422 회피)', async () => {
    h.list.mockResolvedValue([]);
    const manyIds = Array.from({ length: 250 }, (_, i) => `id${i}`).join(',');
    await GET(new Request(`http://localhost/api/goals?ids=${manyIds}`));
    const calledWith = h.list.mock.calls[0]![0] as { ids: string[] };
    expect(calledWith.ids).toHaveLength(200);
  });
});
