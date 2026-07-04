import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b6): proxy 위임 리팩토링 후 stale 재작성 — proxyToFastapiWithParams·auth 게이트.
const { getOrgProjectAuthContext, proxyToFastapiWithParams } = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(), proxyToFastapiWithParams: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

const ID = 'sprint-1';
const TPL = '/api/v2/sprints/[id]/checkin';
const ctx = () => ({ params: Promise.resolve({ id: ID }) });
const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request(`http://localhost/x/${ID}/checkin?date=2026-06-11`);

describe('GET /api/sprints/[id]/checkin (proxyWithParams 위임)', () => {
  beforeEach(() => { getOrgProjectAuthContext.mockReset(); proxyToFastapiWithParams.mockReset(); getOrgProjectAuthContext.mockResolvedValue(agent()); });
  it('401 when unauthenticated', async () => {
    getOrgProjectAuthContext.mockResolvedValue(null);
    expect((await GET(req(), ctx())).status).toBe(401);
    expect(proxyToFastapiWithParams).not.toHaveBeenCalled();
  });
  it('delegates with path template + {id} and wraps', async () => {
    proxyToFastapiWithParams.mockResolvedValue(okRes());
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(expect.anything(), TPL, { id: ID });
    expect((await res.json()).data).toMatchObject({ ok: 1 });
  });
  it('passes through proxy errors', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response('e', { status: 500 }));
    expect((await GET(req(), ctx())).status).toBe(500);
  });
});
