import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/channel-connections (story #3376)', () => {
  it('GET — FastAPI 목록으로 위임, 토큰 필드 없이 그대로 통과', async () => {
    const list = [{ id: 'c1', channel: 'threads', account_id: 'a1', account_label: null, credential_kind: 'oauth', status: 'active', token_expires_at: null, last_refreshed_at: null, last_error: null, can_auto_refresh: true, connected_by: null, created_at: 't', updated_at: 't' }];
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(list));
    const request = new Request('http://test/api/organizations/org-1/channel-connections');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(request, '/api/v2/organizations/[id]/channel-connections', { id: 'org-1' });
    await expect(resp.json()).resolves.toEqual({ data: list, error: null, meta: null });
  });

  it('GET — !ok는 그대로 pass-through(예: 403 CHANNEL_CONNECTION_HUMAN_ONLY)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_CONNECTION_HUMAN_ONLY' } }), { status: 403 }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });
});
