import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

describe('/api/organizations/[id]/channel-connections/[channel]/publishing-limit (story #3402)', () => {
  it('GET — connectionId로 위임(폴더명은 channel이지만 실제 connection_id, 기존 test/route.ts와 동형)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ quota_usage: 3, quota_total: 250, quota_duration_seconds: 86400 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const request = new Request('http://test');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', channel: 'conn-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/[connectionId]/publishing-limit',
      { id: 'org-1', connectionId: 'conn-1' },
    );
    expect(resp.status).toBe(200);
  });

  it('GET — 409(CHANNEL_TOKEN_EXPIRED) 같은 !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_TOKEN_EXPIRED' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', channel: 'conn-1' }) });
    expect(resp.status).toBe(409);
  });
});
