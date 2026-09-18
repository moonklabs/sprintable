import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// 폴더명은 [channel]이지만(Next.js 슬러그명 통일 제약, route.ts 주석 참고) 여기 담기는
// 값은 connection_id다 — 라우트가 되짚어 BE 경로 템플릿엔 [connectionId]로 넘긴다.
describe('/api/organizations/[id]/channel-connections/[connectionId]/test (story #3376)', () => {
  it('POST — {ok,account} 그대로 통과(member 이상, owner 제한 없음)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk({ ok: true, account: { username: 'sprintable_ai' } }));
    const request = new Request('http://test', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', channel: 'c1' }) });
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/[connectionId]/test', { id: 'org-1', connectionId: 'c1' },
    );
    await expect(resp.json()).resolves.toEqual({ data: { ok: true, account: { username: 'sprintable_ai' } }, error: null, meta: null });
  });

  it('POST — {ok:false,error} 실패도 200으로 통과(호출 자체는 성공, 시험 결과가 실패)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk({ ok: false, error: 'TOKEN_EXPIRED' }));
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', channel: 'c1' }) });
    await expect(resp.json()).resolves.toEqual({ data: { ok: false, error: 'TOKEN_EXPIRED' }, error: null, meta: null });
  });
});
