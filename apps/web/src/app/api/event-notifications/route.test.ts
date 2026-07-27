// story #2192 — 알림벨이 30건에서 조용히 잘리던 결함의 회귀가드. BE(/api/v2/event-notifications)는
// limit/offset을 이미 정직히 지원하지만(backend/app/routers/event_notifications.py) 응답이
// 순수 배열이라 "더 있다"는 신호가 없었다 — 프록시가 그 신호(meta.hasMore)를 만드는지 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getServerSession: vi.fn() }));
vi.mock('@/lib/db/server', () => ({ getServerSession: h.getServerSession }));

import { GET } from './route';

describe('/api/event-notifications — meta 구성(story #2192)', () => {
  beforeEach(() => {
    h.getServerSession.mockReset();
    h.getServerSession.mockResolvedValue({ access_token: 'tok' });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('꽉 찬 페이지(limit만큼 반환)면 hasMore=true(31번째가 있을 수 있다는 신호)', async () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}` }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(items), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));

    const req = new Request('http://localhost/api/event-notifications?limit=30&offset=0');
    const res = await GET(req);
    const json = await res.json();

    expect(json.data).toHaveLength(30);
    expect(json.meta.hasMore).toBe(true);
    expect(json.meta.limit).toBe(30);
    expect(json.meta.offset).toBe(0);
  });

  it('음성대조 — 30건 이하 계정(limit 미만 반환)이면 hasMore=false', async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}` }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(items), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));

    const req = new Request('http://localhost/api/event-notifications?limit=30&offset=0');
    const res = await GET(req);
    const json = await res.json();

    expect(json.data).toHaveLength(5);
    expect(json.meta.hasMore).toBe(false);
  });

  it('offset을 그대로 BE에 전달한다(다음 페이지 요청)', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify([]), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const req = new Request('http://localhost/api/event-notifications?limit=30&offset=30');
    await GET(req);

    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('offset=30');
    expect(calledUrl).toContain('limit=30');
  });
});
