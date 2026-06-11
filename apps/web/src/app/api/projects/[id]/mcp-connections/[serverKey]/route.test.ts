import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { DELETE, PUT } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fastapiErr(status: number, body: unknown = { detail: 'upstream error' }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ctx = () => ({ params: Promise.resolve({ id: 'proj-1', serverKey: 'github' }) });

describe('/api/projects/[id]/mcp-connections/[serverKey]', () => {
  it('PUT — FastAPI로 위임하고 성공 body를 { data } 봉투로 래핑', async () => {
    proxyToFastapi.mockResolvedValue(fastapiOk({ server_key: 'github', is_active: true }));
    const request = new Request('http://test', { method: 'PUT', body: JSON.stringify({ is_active: true }) });

    const resp = await PUT(request, ctx());

    expect(proxyToFastapi).toHaveBeenCalledWith(request, '/api/v2/projects/mcp-connections');
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({
      data: { server_key: 'github', is_active: true },
      error: null,
      meta: null,
    });
  });

  it('PUT — !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapi.mockResolvedValue(fastapiErr(404, { detail: 'not found' }));

    const resp = await PUT(new Request('http://test', { method: 'PUT' }), ctx());

    expect(resp.status).toBe(404);
  });

  it('DELETE — FastAPI로 위임하고 204는 { ok: true }로 변환', async () => {
    proxyToFastapi.mockResolvedValue(new Response(null, { status: 204 }));
    const request = new Request('http://test', { method: 'DELETE' });

    const resp = await DELETE(request, ctx());

    expect(proxyToFastapi).toHaveBeenCalledWith(request, '/api/v2/projects/mcp-connections');
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ data: { ok: true } });
  });

  it('DELETE — !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapi.mockResolvedValue(fastapiErr(403, { detail: 'forbidden' }));

    const resp = await DELETE(new Request('http://test', { method: 'DELETE' }), ctx());

    expect(resp.status).toBe(403);
  });
});
