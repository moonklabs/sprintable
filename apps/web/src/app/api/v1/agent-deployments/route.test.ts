import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapi } = vi.hoisted(() => ({
  proxyToFastapi: vi.fn(),
}));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, POST } from './route';

function fastapiOk(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data, error: null, meta: null }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fastapiErr(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ data: null, error: { code, message }, meta: null }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('/api/v1/agent-deployments', () => {
  it('GET — deployment 목록을 data 배열로 반환', async () => {
    proxyToFastapi.mockResolvedValue(fastapiOk([{ id: 'dep-1', name: 'Reviewer' }]));

    const resp = await GET(new Request('http://test'));

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({
      data: [{ id: 'dep-1', name: 'Reviewer' }],
    });
  });

  it('GET — FastAPI 오류 응답을 그대로 pass-through', async () => {
    proxyToFastapi.mockResolvedValue(fastapiErr(403, 'FORBIDDEN', 'org_id required'));

    const resp = await GET(new Request('http://test'));

    expect(resp.status).toBe(403);
  });

  it('GET — 204 응답 시 { ok: true } 반환', async () => {
    proxyToFastapi.mockResolvedValue(new Response(null, { status: 204 }));

    const resp = await GET(new Request('http://test'));

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ data: { ok: true } });
  });

  it('POST — 배포 생성 성공 시 202 + data 반환', async () => {
    proxyToFastapi.mockResolvedValue(fastapiOk({ id: 'dep-1', status: 'DEPLOYING' }, 202));

    const resp = await POST(new Request('http://test', {
      method: 'POST',
      body: JSON.stringify({ agent_id: 'a', name: 'Reviewer' }),
    }));

    expect(resp.status).toBe(202);
    await expect(resp.json()).resolves.toMatchObject({
      data: { id: 'dep-1', status: 'DEPLOYING' },
    });
  });

  it('POST — FastAPI 오류 응답을 그대로 pass-through', async () => {
    proxyToFastapi.mockResolvedValue(fastapiErr(409, 'CONFLICT', 'Deployment already exists'));

    const resp = await POST(new Request('http://test', {
      method: 'POST',
      body: JSON.stringify({ agent_id: 'a' }),
    }));

    expect(resp.status).toBe(409);
  });
});
