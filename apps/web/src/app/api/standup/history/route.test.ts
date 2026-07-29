import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getOrgProjectAuthContext, proxyToFastapi } = vi.hoisted(() => ({
  getOrgProjectAuthContext: vi.fn(),
  proxyToFastapi: vi.fn(),
}));

vi.mock('@/lib/auth-helpers', () => ({ getOrgProjectAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

function makeAgent() {
  return { id: 'agent-1', type: 'agent', rateLimitExceeded: false, rateLimitRemaining: 299, rateLimitResetAt: 0 };
}

describe('GET /api/standup/history', () => {
  beforeEach(() => {
    getOrgProjectAuthContext.mockReset();
    proxyToFastapi.mockReset();
    getOrgProjectAuthContext.mockResolvedValue(makeAgent());
  });

  it('returns 401 when not authenticated', async () => {
    getOrgProjectAuthContext.mockResolvedValue(null);

    const response = await GET(
      new Request('http://localhost/api/standup/history?project_id=project-1'),
    );

    expect(response.status).toBe(401);
  });

  it('returns 200 with standup entries and unwraps 규약A meta without double-wrapping', async () => {
    const entries = [
      { id: 'e1', author_id: 'member-1', date: '2026-04-06', done: 'done', plan: 'plan', blockers: null },
      { id: 'e2', author_id: 'member-2', date: '2026-04-05', done: 'done', plan: 'plan', blockers: null },
    ];
    // story #2248: BE list_standup_history는 #2231 규약A 봉투({data,meta})를 낸다(bare array 아님).
    proxyToFastapi.mockResolvedValue(
      new Response(JSON.stringify({ data: entries, meta: { has_more: true, next_cursor: '2026-04-05T00:00:00Z' } }), { status: 200 }),
    );

    const response = await GET(
      new Request('http://localhost/api/standup/history?project_id=project-1'),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    // 이중포장 회귀가드 — body.data가 배열 자체여야 한다({data:{data:[...]}}가 아니라).
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ id: 'e1', author_id: 'member-1' });
    expect(body.meta).toMatchObject({ has_more: true, next_cursor: '2026-04-05T00:00:00Z' });
  });

  it('경로 회귀가드(#2248) — /api/v2/standups/history를 부른다(/api/v2/standups 아님)', async () => {
    proxyToFastapi.mockResolvedValue(
      new Response(JSON.stringify({ data: [], meta: { has_more: false, next_cursor: null } }), { status: 200 }),
    );

    await GET(new Request('http://localhost/api/standup/history?project_id=project-1'));

    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), '/api/v2/standups/history');
  });

  it('forwards upstream error status', async () => {
    proxyToFastapi.mockResolvedValue(new Response('not found', { status: 404 }));

    const response = await GET(
      new Request('http://localhost/api/standup/history?project_id=project-1'),
    );

    expect(response.status).toBe(404);
  });
});
