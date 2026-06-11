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

describe('/api/agent-runs', () => {
  it('GET — FastAPI로 위임하고 성공 body를 { data } 봉투로 래핑', async () => {
    proxyToFastapi.mockResolvedValue(fastapiOk([{ id: 'run-1', status: 'running' }]));
    const request = new Request('http://test/api/agent-runs?project_id=p1');

    const resp = await GET(request);

    expect(proxyToFastapi).toHaveBeenCalledWith(request, '/api/v2/agent-runs');
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({
      data: [{ id: 'run-1', status: 'running' }],
      error: null,
      meta: null,
    });
  });

  it('GET — !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapi.mockResolvedValue(fastapiErr(403, { detail: 'forbidden' }));

    const resp = await GET(new Request('http://test/api/agent-runs'));

    expect(resp.status).toBe(403);
  });

  it('POST — FastAPI로 위임하고 성공 body를 { data } 봉투로 래핑', async () => {
    proxyToFastapi.mockResolvedValue(fastapiOk({ id: 'run-1', status: 'queued' }));
    const request = new Request('http://test', { method: 'POST', body: JSON.stringify({ agent_id: 'a1' }) });

    const resp = await POST(request);

    expect(proxyToFastapi).toHaveBeenCalledWith(request, '/api/v2/agent-runs');
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({
      data: { id: 'run-1', status: 'queued' },
      error: null,
      meta: null,
    });
  });

  it('POST — 204 응답은 { ok: true }로 변환', async () => {
    proxyToFastapi.mockResolvedValue(new Response(null, { status: 204 }));

    const resp = await POST(new Request('http://test', { method: 'POST' }));

    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ data: { ok: true } });
  });
});
