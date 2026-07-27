import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAuthContext, proxyToFastapi } = vi.hoisted(() => ({ getAuthContext: vi.fn(), proxyToFastapi: vi.fn() }));
vi.mock('@/lib/auth-helpers', () => ({ getAuthContext }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapi }));

import { POST } from './route';

const agent = () => ({ id: 'a', type: 'agent' });
const enveloped = (data: unknown) =>
  new Response(JSON.stringify({ data, error: null, meta: null }), { status: 200, headers: { 'content-type': 'application/json' } });
const req = () => new Request('http://localhost/api/visual-artifacts/a1/versions/1/export/png/upload-url', { method: 'POST', body: JSON.stringify({ content_type: 'image/png' }) });
const params = { params: Promise.resolve({ id: 'a1', versionNumber: '1' }) };

describe('POST .../export/png/upload-url (BE _ok() 이중 봉투 unwrap 회귀가드)', () => {
  beforeEach(() => { getAuthContext.mockReset(); proxyToFastapi.mockReset(); getAuthContext.mockResolvedValue(agent()); });

  it('401 when unauthenticated', async () => {
    getAuthContext.mockResolvedValue(null);
    expect((await POST(req(), params)).status).toBe(401);
    expect(proxyToFastapi).not.toHaveBeenCalled();
  });

  it('unwraps the envelope — upload_url/object_path/expires_at land directly on .data', async () => {
    const uploadInfo = { upload_url: 'https://storage.example/put', object_path: 'org/proj/artifact/x.png', expires_at: '2026-07-10T00:10:00Z' };
    proxyToFastapi.mockResolvedValue(enveloped(uploadInfo));
    const res = await POST(req(), params);
    const json = await res.json() as { data: unknown };
    expect(json.data).toEqual(uploadInfo);
  });

  it('passes through proxy errors', async () => {
    proxyToFastapi.mockResolvedValue(new Response('not found', { status: 404 }));
    expect((await POST(req(), params)).status).toBe(404);
  });
});
