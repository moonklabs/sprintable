import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET, POST } from './route';

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

const ctx = (id = 'proj-1') => ({ params: Promise.resolve({ id }) });

describe('/api/projects/[id]/mcp-connections', () => {
  it('GET — OSS 모드: proxy 없이 빈 connections 정적 응답', async () => {
    const resp = await GET(new Request('http://test'), ctx('proj-1'));

    expect(proxyToFastapi).not.toHaveBeenCalled();
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({
      data: { project_id: 'proj-1', connections: [] },
    });
  });

  it('POST — FastAPI로 위임하고 성공 body를 { data } 봉투로 래핑', async () => {
    proxyToFastapi.mockResolvedValue(fastapiOk({ server_key: 'github', is_active: true }));
    const request = new Request('http://test', { method: 'POST', body: JSON.stringify({ server_key: 'github' }) });

    const resp = await POST(request, ctx());

    expect(proxyToFastapi).toHaveBeenCalledWith(request, '/api/v2/projects/mcp-connections');
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({
      data: { server_key: 'github', is_active: true },
      error: null,
      meta: null,
    });
  });

  it('POST — !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapi.mockResolvedValue(fastapiErr(403, { detail: 'forbidden' }));

    const resp = await POST(new Request('http://test', { method: 'POST' }), ctx());

    expect(resp.status).toBe(403);
  });

  it('POST — 204 응답은 { ok: true }로 변환', async () => {
    proxyToFastapi.mockResolvedValue(new Response(null, { status: 204 }));

    const resp = await POST(new Request('http://test', { method: 'POST' }), ctx());

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ data: { ok: true } });
  });
});
