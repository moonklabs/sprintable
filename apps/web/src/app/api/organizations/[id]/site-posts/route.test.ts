import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/site-posts (story #3368, 발행)', () => {
  it('POST — FastAPI POST /api/v2/organizations/[id]/site-posts로 위임하고 { data } 봉투로 래핑', async () => {
    const result = { id: 'p1', slug: '2ho-blog', title: '2호 글', lang: 'ko', published_at: '2026-09-05T00:00:00Z', gate_id: 'g1' };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(result));

    const request = new Request('http://test/api/organizations/org-1/site-posts', {
      method: 'POST', body: JSON.stringify({ work_item_id: 'w1', gate_id: 'g1', title: 't', slug: 's', lang: 'ko', summary: 'sm', tags: [], body_md: 'b' }),
    });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/site-posts', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('POST — 403(게이트 미승인·휴먼 전용) 같은 !ok 응답은 그대로 pass-through(S10 원문 보존)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'EXTERNAL_PUBLISH_APPROVAL_REQUIRED' } }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });
});
