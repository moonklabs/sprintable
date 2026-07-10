import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { POST } from './route';

const agent = () => ({ id: 'a', type: 'agent' });
const enveloped = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data, error: null, meta: null }), { status, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/visual-artifacts/a1/versions/1/export/html', { method: 'POST' });
const params = { params: Promise.resolve({ id: 'a1', versionNumber: '1' }) };

describe('POST .../export/html (BE _ok() 이중 봉투 unwrap 회귀가드)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(agent()); });

  it('401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await POST(req(), params)).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('unwraps the envelope and passes through the 201 status (렌더/캡처 불요 — 단일 호출)', async () => {
    const exportRow = { id: 'e1', artifact_id: 'a1', version_id: 'v1', version_number: 1, format: 'html', created_by: 'm1', created_at: '2026-07-10T00:00:00Z', asset_id: 'as1', download_url: 'https://storage.example/read' };
    proxyToFastapi.mockResolvedValue(enveloped(exportRow, 201));
    const res = await POST(req(), params);
    expect(res.status).toBe(201);
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual(exportRow);
  });

  it('passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('not found', { status: 404 }));
    expect((await POST(req(), params)).status).toBe(404);
  });
});
