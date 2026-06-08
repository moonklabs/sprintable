import { beforeEach, describe, expect, it, vi } from 'vitest';

const { proxyToFastapi } = vi.hoisted(() => ({
  proxyToFastapi: vi.fn(),
}));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

describe('GET /api/members', () => {
  beforeEach(() => {
    proxyToFastapi.mockReset();
  });

  it('proxies to canonical /api/v2/members (SSOT)', async () => {
    proxyToFastapi.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));

    await GET(new Request('http://localhost/api/members?project_id=project-1'));

    expect(proxyToFastapi).toHaveBeenCalledWith(expect.any(Request), '/api/v2/members');
  });

  it('passes through upstream error responses', async () => {
    proxyToFastapi.mockResolvedValue(new Response('nope', { status: 401 }));

    const response = await GET(new Request('http://localhost/api/members?project_id=project-1'));

    expect(response.status).toBe(401);
  });

  it('wraps the member array in apiSuccess data envelope', async () => {
    const members = [
      { id: 'member-alpha', name: 'Alpha Owner', type: 'human', role: 'owner', is_active: true },
    ];
    proxyToFastapi.mockResolvedValue(new Response(JSON.stringify(members), { status: 200 }));

    const response = await GET(new Request('http://localhost/api/members?project_id=project-alpha'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual(members);
  });
});
