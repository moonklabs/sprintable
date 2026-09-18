import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/channel-connections/[channel]/authorize (story #3376)', () => {
  it('POST — {url,state}를 그대로 전달(body 없이 위임)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk({ url: 'https://threads.net/oauth/authorize?...', state: 'opaque' }));
    const request = new Request('http://test/api/organizations/org-1/channel-connections/threads/authorize', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', channel: 'threads' }) });
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/[channel]/authorize', { id: 'org-1', channel: 'threads' },
    );
    await expect(resp.json()).resolves.toEqual({ data: { url: 'https://threads.net/oauth/authorize?...', state: 'opaque' }, error: null, meta: null });
  });

  it('POST — 409 CHANNEL_APP_CREDENTIALS_MISSING은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_APP_CREDENTIALS_MISSING' } }), { status: 409 }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', channel: 'threads' }) });
    expect(resp.status).toBe(409);
  });
});
