import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET, PUT } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/channel-connections/[channel]/app-credentials (story #3376)', () => {
  it('GET — effective_source·app_id_suffix만 통과, secret 필드는 응답에 없음', async () => {
    const status = { configured: true, app_id_suffix: 'ab12', updated_by: 'm1', updated_at: 't', effective_source: 'org' };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(status));
    const request = new Request('http://test');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', channel: 'threads' }) });
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/[channel]/app-credentials', { id: 'org-1', channel: 'threads' },
    );
    const json = await resp.json() as { data: Record<string, unknown> };
    expect(json.data).toEqual(status);
    expect(JSON.stringify(json)).not.toContain('secret');
  });

  it('PUT — {app_id,app_secret} 바디를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk({ configured: true, app_id: 'my-app-id' }));
    const request = new Request('http://test', { method: 'PUT', body: JSON.stringify({ app_id: 'my-app-id', app_secret: 'shh' }) });
    const resp = await PUT(request, { params: Promise.resolve({ id: 'org-1', channel: 'threads' }) });
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/[channel]/app-credentials', { id: 'org-1', channel: 'threads' },
    );
    await expect(resp.json()).resolves.toEqual({ data: { configured: true, app_id: 'my-app-id' }, error: null, meta: null });
  });

  it('PUT — 403 CHANNEL_CONNECTION_OWNER_ONLY는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_CONNECTION_OWNER_ONLY' } }), { status: 403 }),
    );
    const resp = await PUT(new Request('http://test', { method: 'PUT' }), { params: Promise.resolve({ id: 'org-1', channel: 'threads' }) });
    expect(resp.status).toBe(403);
  });
});
