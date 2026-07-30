import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOrgProjectAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getOrgProjectAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

const PATH = '/api/v2/analytics/epics-progress-lane';
const agent = () => ({ id: 'a', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 });
const okRes = (b: unknown = { epics: {}, zones: {}, stall_threshold_hours: 168, stories_without_epic: 0 }) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/analytics/epics-progress-lane?project_id=p');

describe('GET /api/analytics/epics-progress-lane (proxy 위임)', () => {
  beforeEach(() => { getOrgProjectAuthContext.mockReset(); proxyToFastapi.mockReset(); getOrgProjectAuthContext.mockResolvedValue(agent()); });

  it('401 when unauthenticated', async () => {
    getOrgProjectAuthContext.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('delegates to the backend path with the same request(query string forwarded by proxyToFastapi)', async () => {
    proxyToFastapi.mockResolvedValue(okRes());
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), PATH);
    expect((await res.json()).data).toMatchObject({ stall_threshold_hours: 168 });
  });

  it('passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('e', { status: 500 }));
    expect((await GET(req())).status).toBe(500);
  });
});
