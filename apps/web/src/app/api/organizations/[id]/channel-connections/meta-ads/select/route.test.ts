import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

// story #3806 PR 7(페드루 PO 리뷰 2026-09-11 14:16Z 실측 — 이 BFF 라우트 파일 자체가
// 없어 실 클릭에서 404였던 결함) — facebook/select/route.test.ts와 동형.
describe('/api/organizations/[id]/channel-connections/meta-ads/select (story #3806 PR 7)', () => {
  it('⭐POST — FastAPI 리터럴 meta-ads/select 엔드포인트로 id를 그대로 위임(account_id 축)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'c1', channel: 'ads_sandbox', account_id: 'sandbox-ads-account-1', account_label: 'Sandbox Ads Account 1', status: 'active' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', { method: 'POST', body: JSON.stringify({ pending_id: 'p1', account_id: 'sandbox-ads-account-1' }) });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/meta-ads/select', { id: 'org-1' },
    );
    expect(resp.status).toBe(201);
    await expect(resp.json()).resolves.toMatchObject({ data: { account_label: 'Sandbox Ads Account 1' } });
  });

  // story #3806 PR 7 — select 실패 4종(meta_ads_select_account_endpoint 실측: NOT_FOUND·
  // EXPIRED·FORBIDDEN·INVALID_ACCOUNT). 이 BFF는 재분류 없이 그대로 pass-through.
  it.each([
    ['CHANNEL_OAUTH_PENDING_SELECTION_NOT_FOUND', 404],
    ['CHANNEL_OAUTH_PENDING_SELECTION_EXPIRED', 404],
    ['CHANNEL_OAUTH_PENDING_SELECTION_FORBIDDEN', 403],
    ['CHANNEL_OAUTH_PENDING_SELECTION_INVALID_ACCOUNT', 400],
  ] as const)('POST — %s(%i)도 그대로 pass-through', async (code, status) => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ error: { code } }), { status, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1' }),
    });
    expect(resp.status).toBe(status);
  });
});
