import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

describe('/api/organizations/[id]/channel-connections/facebook/select (story #3549)', () => {
  it('POST — FastAPI 리터럴 facebook/select 엔드포인트로 id를 그대로 위임(디디 PR#3904 실측 — channel 세그먼트 없음)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'c1', channel: 'facebook', account_id: 'page-1', account_label: '우리 회사 페이지', status: 'active' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', { method: 'POST', body: JSON.stringify({ pending_id: 'p1', page_id: 'page-1' }) });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/facebook/select', { id: 'org-1' },
    );
    expect(resp.status).toBe(201);
    await expect(resp.json()).resolves.toMatchObject({ data: { account_label: '우리 회사 페이지' } });
  });

  // story #3549(디디 계약, PR#3904 실측) — select 실패 5종. 이 BFF는 재분류 없이
  // 전부 그대로 pass-through(화면이 t()로 문구를 고른다).
  it.each([
    ['CHANNEL_OAUTH_PENDING_SELECTION_NOT_FOUND', 404],
    ['CHANNEL_OAUTH_PENDING_SELECTION_EXPIRED', 404],
    ['CHANNEL_OAUTH_PENDING_SELECTION_FORBIDDEN', 403],
    ['CHANNEL_OAUTH_PENDING_SELECTION_INVALID_PAGE', 400],
    ['CHANNEL_OAUTH_PROVIDER_UNAVAILABLE', 503],
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
