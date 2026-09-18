import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/channel-connections/[channel]/callback (story #3376)', () => {
  it('POST — {code,state} 바디를 그대로 위임하고 새 ChannelConnectionResponse를 돌려받는다', async () => {
    const conn = { id: 'c1', channel: 'threads', account_id: 'a1', account_label: '@x', credential_kind: 'oauth', status: 'active', token_expires_at: null, last_refreshed_at: null, last_error: null, can_auto_refresh: true, connected_by: 'm1', created_at: 't', updated_at: 't' };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(conn));
    const request = new Request('http://test', { method: 'POST', body: JSON.stringify({ code: 'c', state: 's' }) });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', channel: 'threads' }) });
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/[channel]/callback', { id: 'org-1', channel: 'threads' },
    );
    await expect(resp.json()).resolves.toEqual({ data: conn, error: null, meta: null });
  });

  it('POST — 400 CHANNEL_OAUTH_STATE_INVALID은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_OAUTH_STATE_INVALID' } }), { status: 400 }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', channel: 'threads' }) });
    expect(resp.status).toBe(400);
  });
});
