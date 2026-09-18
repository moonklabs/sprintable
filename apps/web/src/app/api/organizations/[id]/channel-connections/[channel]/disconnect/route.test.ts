import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// 폴더명은 [channel]이지만(Next.js 슬러그명 통일 제약, route.ts 주석 참고) 여기 담기는
// 값은 connection_id다 — 라우트가 되짚어 BE 경로 템플릿엔 [connectionId]로 넘긴다.
describe('/api/organizations/[id]/channel-connections/[connectionId]/disconnect (story #3376)', () => {
  it('POST — connectionId(UUID)로 위임하고 갱신된 ChannelConnectionResponse를 돌려받는다', async () => {
    const conn = { id: 'c1', channel: 'threads', account_id: 'a1', account_label: '@x', credential_kind: 'oauth', status: 'revoked', token_expires_at: null, last_refreshed_at: null, last_error: null, can_auto_refresh: false, connected_by: 'm1', created_at: 't', updated_at: 't' };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(conn));
    const request = new Request('http://test', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', channel: 'c1' }) });
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/[connectionId]/disconnect', { id: 'org-1', connectionId: 'c1' },
    );
    await expect(resp.json()).resolves.toEqual({ data: conn, error: null, meta: null });
  });

  it('POST — 403 CHANNEL_CONNECTION_OWNER_ONLY(member 시도)는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_CONNECTION_OWNER_ONLY' } }), { status: 403 }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', channel: 'c1' }) });
    expect(resp.status).toBe(403);
  });
});
