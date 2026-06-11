import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { DELETE, GET, PUT } from './route';

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

describe('/api/projects/[id]/ai-settings', () => {
  it('GET — FastAPI로 위임하고 성공 body를 { data } 봉투로 래핑', async () => {
    proxyToFastapi.mockResolvedValue(fastapiOk({ provider: 'anthropic', masked_key: '****1234' }));
    const request = new Request('http://test');

    const resp = await GET(request, ctx());

    expect(proxyToFastapi).toHaveBeenCalledWith(request, '/api/v2/projects/ai-settings');
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({
      data: { provider: 'anthropic', masked_key: '****1234' },
      error: null,
      meta: null,
    });
  });

  it('GET — !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapi.mockResolvedValue(fastapiErr(403, { detail: 'forbidden' }));

    const resp = await GET(new Request('http://test'), ctx());

    expect(resp.status).toBe(403);
  });

  it('PUT — FastAPI로 위임하고 성공 body를 { data } 봉투로 래핑', async () => {
    proxyToFastapi.mockResolvedValue(fastapiOk({ provider: 'openai', masked_key: '****5678' }));
    const request = new Request('http://test', { method: 'PUT', body: JSON.stringify({ provider: 'openai', api_key: 'sk-x' }) });

    const resp = await PUT(request, ctx());

    expect(proxyToFastapi).toHaveBeenCalledWith(request, '/api/v2/projects/ai-settings');
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({
      data: { provider: 'openai', masked_key: '****5678' },
    });
  });

  it('DELETE — 204 응답은 { ok: true }로 변환', async () => {
    proxyToFastapi.mockResolvedValue(new Response(null, { status: 204 }));
    const request = new Request('http://test', { method: 'DELETE' });

    const resp = await DELETE(request, ctx());

    expect(proxyToFastapi).toHaveBeenCalledWith(request, '/api/v2/projects/ai-settings');
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ data: { ok: true } });
  });

  it('DELETE — !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapi.mockResolvedValue(fastapiErr(404, { detail: 'not found' }));

    const resp = await DELETE(new Request('http://test', { method: 'DELETE' }), ctx());

    expect(resp.status).toBe(404);
  });
});
