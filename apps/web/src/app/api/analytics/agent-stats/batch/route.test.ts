// story #4185 — 묶음 BFF는 FastAPI 묶음 경로로 그대로 프록시하고 응답을 apiSuccess로 감싼다.
import { beforeEach, expect, it, vi } from 'vitest';

const { getOrgProjectAuthContext, proxyToFastapi } = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(), proxyToFastapi: vi.fn(),
}));
vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

beforeEach(() => {
  getOrgProjectAuthContext.mockReset(); proxyToFastapi.mockReset();
  getOrgProjectAuthContext.mockResolvedValue({ rateLimitExceeded: false, rateLimitRemaining: 1, rateLimitResetAt: 0 });
});

it('FastAPI /api/v2/analytics/agent-stats/batch로 프록시하고 data에 싣는다', async () => {
  proxyToFastapi.mockResolvedValue(new Response(JSON.stringify({ 'ag-1': { completed: 2 } }), { status: 200 }));
  const req = new Request('http://x/api/analytics/agent-stats/batch?project_id=p&agent_ids=ag-1');
  const res = await GET(req);
  expect(proxyToFastapi).toHaveBeenCalledWith(req, '/api/v2/analytics/agent-stats/batch');
  expect((await res.json()).data).toEqual({ 'ag-1': { completed: 2 } });
});

it('인증 없으면 401', async () => {
  getOrgProjectAuthContext.mockResolvedValue(null);
  const res = await GET(new Request('http://x/api/analytics/agent-stats/batch?project_id=p&agent_ids=a'));
  expect(res.status).toBe(401);
  expect(proxyToFastapi).not.toHaveBeenCalled();
});
