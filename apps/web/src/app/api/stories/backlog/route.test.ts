// story #2190 — 백로그 「더 보기」가 프록시의 meta 누락으로 영영 안 뜨던 결함의 회귀가드.
// fastapi-proxy.ts가 X-Total-Count/X-Next-Cursor를 forward하게 고친 뒤, 이 route가 그
// 헤더를 실제로 meta로 옮기는지 + 음성대조(더 줄 게 없으면 hasMore가 false로 남는지)를 고정한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getOrgProjectAuthContext: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext: h.getOrgProjectAuthContext }));

import { GET } from './route';

describe('/api/stories/backlog — meta 구성(story #2190)', () => {
  beforeEach(() => {
    h.getOrgProjectAuthContext.mockReset();
    h.getOrgProjectAuthContext.mockResolvedValue({ type: 'human', project_id: 'p1', rateLimitExceeded: false });
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('꽉 찬 페이지(limit만큼 반환)면 hasMore=true·nextCursor가 실린다', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}` }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(items), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-total-count': '278', 'x-next-cursor': '2026-07-23T07:20:58Z' },
    })));

    const req = new Request('http://localhost/api/stories/backlog?project_id=p1&limit=20', { headers: { Authorization: 'Bearer tok' } });
    const res = await GET(req);
    const json = await res.json();

    expect(json.data).toHaveLength(20);
    expect(json.meta.hasMore).toBe(true);
    expect(json.meta.nextCursor).toBe('2026-07-23T07:20:58Z');
    expect(json.meta.total).toBe(278);
  });

  it('음성대조 — 마지막 페이지(limit 미만 반환)면 hasMore=false·nextCursor=null', async () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}` })); // limit(20) 미만
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(items), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-total-count': '27', 'x-next-cursor': '2026-07-23T07:20:58Z' },
    })));

    const req = new Request('http://localhost/api/stories/backlog?project_id=p1&limit=20', { headers: { Authorization: 'Bearer tok' } });
    const res = await GET(req);
    const json = await res.json();

    expect(json.data).toHaveLength(7);
    expect(json.meta.hasMore).toBe(false);
    expect(json.meta.nextCursor).toBeNull(); // 더 줄 게 없으므로 커서를 실어 보내지 않음(버튼이 다시 안 뜸)
  });

  it('음성대조 — 결과가 아예 0건이면 hasMore=false(X-Next-Cursor 자체가 안 옴)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-total-count': '0' }, // BE가 빈 목록엔 next-cursor를 안 실음
    })));

    const req = new Request('http://localhost/api/stories/backlog?project_id=p1&limit=20', { headers: { Authorization: 'Bearer tok' } });
    const res = await GET(req);
    const json = await res.json();

    expect(json.data).toHaveLength(0);
    expect(json.meta.hasMore).toBe(false);
  });

  it('total 헤더가 없으면 meta.total 자체가 없다(추측으로 0을 채우지 않음)', async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}` }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(items), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const req = new Request('http://localhost/api/stories/backlog?project_id=p1&limit=20', { headers: { Authorization: 'Bearer tok' } });
    const res = await GET(req);
    const json = await res.json();

    expect('total' in json.meta).toBe(false);
  });
});
