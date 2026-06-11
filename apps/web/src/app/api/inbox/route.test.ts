import { beforeEach, describe, expect, it, vi } from 'vitest';

// 837a36c4(Group B b5): proxy 위임 리팩토링 후 stale 재작성. inbox는 assignee_member_id 자동주입 후 위임.
const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

const agent = () => ({ id: 'mem-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const okRes = (b: unknown = { ok: 1 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/inbox');

describe('GET /api/inbox (proxy 위임)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(agent()); });
  it('401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });
  it('delegates to /api/v2/inbox (assignee 자동주입) and wraps', async () => {
    proxyToFastapi.mockResolvedValue(okRes());
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), '/api/v2/inbox');
    // assignee_member_id가 caller id로 주입된 Request로 위임
    const fwd = proxyToFastapi.mock.calls[0][0] as Request;
    expect(new URL(fwd.url).searchParams.get('assignee_member_id')).toBe('mem-1');
    expect((await res.json()).data).toMatchObject({ ok: 1 });
  });
  it('passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status: 502 }));
    expect((await GET(req())).status).toBe(502);
  });
});
