import { beforeEach, describe, expect, it, vi } from 'vitest';

// story #2299(E-CONNECT) — BE list_entity_backlinks도 convention-A({data,meta})라
// activities/route.ts(#2247/#2564)와 같은 이중포장 위험을 처음부터 봉쇄한다.
const h = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(),
  proxyToFastapiWithParams: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext: h.getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams: h.proxyToFastapiWithParams }));

import { GET } from './route';

const ctx = () => ({ params: Promise.resolve({ id: 'story-1' }) });
const req = () => new Request('http://localhost/api/stories/story-1/backlinks');
const me = () => ({ id: 'a', org_id: 'org-1', project_id: 'p1', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });

describe('GET /api/stories/[id]/backlinks — 이중포장 회귀 방지 + still_exists/collection_scope 왕복', () => {
  beforeEach(() => {
    h.getOrgProjectAuthContext.mockReset();
    h.proxyToFastapiWithParams.mockReset();
    h.getOrgProjectAuthContext.mockResolvedValue(me());
  });

  it('BE convention-A 응답이 이중포장 없이 그대로 나온다 — still_exists·collection_scope 보존', async () => {
    h.proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({
        data: [{ id: 'r1', source_type: 'doc', still_exists: false, doc: { id: 'd1', title: 'X' }, message: null }],
        meta: { next_cursor: null, has_more: false, collection_scope: { source_types: ['chat_message', 'doc'], forms: 'all', excludes: [] } },
      }), { status: 200 }),
    );
    const res = await GET(req(), ctx());
    const json = await res.json() as { data: { still_exists: boolean }[]; meta: { collection_scope: unknown } };
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data[0]!.still_exists).toBe(false);
    expect(json.meta.collection_scope).toEqual({ source_types: ['chat_message', 'doc'], forms: 'all', excludes: [] });
  });
});
