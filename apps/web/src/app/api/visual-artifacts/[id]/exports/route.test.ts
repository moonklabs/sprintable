import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { GET } from './route';

const agent = () => ({ id: 'a', type: 'agent' });
const enveloped = (data: unknown) =>
  new Response(JSON.stringify({ data, error: null, meta: null }), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/visual-artifacts/a1/exports');
const params = { params: Promise.resolve({ id: 'a1' }) };

describe('GET .../exports (BE _ok() 이중 봉투 unwrap 회귀가드)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(agent()); });

  it('401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await GET(req(), params)).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('unwraps the envelope — array lands directly on .data, not .data.data', async () => {
    const exports = [{ id: 'e1', artifact_id: 'a1', version_id: 'v1', version_number: 1, format: 'png', created_by: 'm1', created_at: '2026-07-10T00:00:00Z', asset_id: 'as1', download_url: 'https://storage.example/read' }];
    proxyToFastapi.mockResolvedValue(enveloped(exports));
    const res = await GET(req(), params);
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual(exports);
  });

  it('falls back to an empty array when the upstream envelope has no data field', () => {
    proxyToFastapi.mockResolvedValue(new Response(JSON.stringify({ error: null, meta: null }), { status: 200 }));
    return GET(req(), params).then(async (res) => {
      const json = await res.json() as { data: unknown };
      expect(json.data).toEqual([]);
    });
  });
});
