import { beforeEach, describe, expect, it, vi } from 'vitest';

// 긴급 정정(2026-07-28, prod 크래시): #2247이 BE list_activities에 convention-A({data,meta})를
// 적용했는데 이 프록시가 apiSuccess(json)에 그대로 넘겨 이중포장했다 — story-detail-panel.tsx의
// activities.map()이 「activities.map is not a function」으로 터지던 실제 원인.
const h = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(),
  proxyToFastapiWithParams: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext: h.getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams: h.proxyToFastapiWithParams }));

import { GET } from './route';

const ctx = () => ({ params: Promise.resolve({ id: 'story-1' }) });
const req = () => new Request('http://localhost/api/stories/story-1/activities?limit=20');
const me = () => ({ id: 'a', org_id: 'org-1', project_id: 'p1', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });

describe('GET /api/stories/[id]/activities — 이중포장 회귀 방지', () => {
  beforeEach(() => {
    h.getOrgProjectAuthContext.mockReset();
    h.proxyToFastapiWithParams.mockReset();
    h.getOrgProjectAuthContext.mockResolvedValue(me());
  });

  it('BE가 이미 {data,meta}를 내면(convention-A) data 배열이 최상위 data로 그대로 나온다(이중포장 없음)', async () => {
    h.proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'act-1', activity_type: 'status_changed' }], meta: { has_more: false, next_cursor: null } }), { status: 200 }),
    );
    const res = await GET(req(), ctx());
    const json = await res.json() as { data: unknown; meta: unknown };
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data).toEqual([{ id: 'act-1', activity_type: 'status_changed' }]);
    expect(json.meta).toEqual({ has_more: false, next_cursor: null });
  });

  it('BE 응답이 예외적으로 봉투 없이 온다면(과거 형상) 그 값 전체를 data로 감싼다(폴백)', async () => {
    h.proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify([{ id: 'act-1' }]), { status: 200 }),
    );
    const res = await GET(req(), ctx());
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual([{ id: 'act-1' }]);
  });
});
