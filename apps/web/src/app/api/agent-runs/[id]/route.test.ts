import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapi } = vi.hoisted(() => ({ proxyToFastapi: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { PATCH } from './route';

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

const ctx = (id = 'run-123') => ({ params: Promise.resolve({ id }) });

describe('/api/agent-runs/[id]', () => {
  it('PATCH — 보간된 run 경로로 위임하고 성공 body를 { data } 봉투로 래핑', async () => {
    proxyToFastapi.mockResolvedValue(fastapiOk({ id: 'run-123', status: 'succeeded' }));
    const request = new Request('http://test', { method: 'PATCH', body: JSON.stringify({ status: 'succeeded' }) });

    const resp = await PATCH(request, ctx('run-123'));

    expect(proxyToFastapi).toHaveBeenCalledWith(request, '/api/v2/agent-runs/run-123');
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({
      data: { id: 'run-123', status: 'succeeded' },
      error: null,
      meta: null,
    });
  });

  it('PATCH — !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapi.mockResolvedValue(fastapiErr(404, { detail: 'run not found' }));

    const resp = await PATCH(new Request('http://test', { method: 'PATCH' }), ctx('missing'));

    expect(proxyToFastapi).toHaveBeenCalledWith(expect.anything(), '/api/v2/agent-runs/missing');
    expect(resp.status).toBe(404);
  });

  it('PATCH — 204 응답은 { ok: true }로 변환', async () => {
    proxyToFastapi.mockResolvedValue(new Response(null, { status: 204 }));

    const resp = await PATCH(new Request('http://test', { method: 'PATCH' }), ctx());

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ data: { ok: true } });
  });
});
