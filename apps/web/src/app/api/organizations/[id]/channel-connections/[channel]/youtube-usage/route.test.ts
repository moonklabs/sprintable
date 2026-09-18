import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

describe('/api/organizations/[id]/channel-connections/[channel]/youtube-usage (story #3815 PR4)', () => {
  it('GET — connectionId로 위임(폴더명은 channel이지만 실제 connection_id, publishing-limit과 동형)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ used_units: 120, limit_units: 10000, remaining_units: 9880, reset_at: '2026-09-13T00:00:00Z', scope: 'platform' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', channel: 'conn-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/[connectionId]/youtube-usage',
      { id: 'org-1', connectionId: 'conn-1' },
    );
    expect(resp.status).toBe(200);
  });

  it('GET — !ok 응답(BE 갭·인가실패 등)은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_TOKEN_EXPIRED' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', channel: 'conn-1' }) });
    expect(resp.status).toBe(409);
  });

  it('GET — BE의 401도 삼키지 않고 그대로 통과', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(null, { status: 401 }));
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', channel: 'conn-1' }) });
    expect(resp.status).toBe(401);
  });
});
