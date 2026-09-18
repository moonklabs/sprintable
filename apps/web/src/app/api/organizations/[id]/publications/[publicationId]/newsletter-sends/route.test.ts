import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// story #3813(Phase3·3-4 PR4, 페드루 PO 確定 2026-09-12) — boosts/route.test.ts와 동형.
// 라이브 회차 1(2026-09-12) 실측 갭(이 프록시 부재로 발송 요청이 dev-app에서 404) — 이
// 테스트가 그 배선을 회귀 고정한다.
describe('/api/organizations/[id]/publications/[publicationId]/newsletter-sends (story #3813)', () => {
  it('POST — FastAPI POST .../newsletter-sends로 위임하고 { data } 봉투로 래핑', async () => {
    const result = {
      gate_id: 'gate-1', status: 'pending', reapproval_required: false,
      sealed_newsletter_segment_name: '전체 구독자', sealed_newsletter_scheduled_at: '2026-09-19T00:00:00Z',
    };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(result, 201));

    const request = new Request('http://test/api/organizations/org-1/publications/pub-1/newsletter-sends', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/publications/[publicationId]/newsletter-sends', { id: 'org-1', publicationId: 'pub-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('POST — 발행 前 요청(409 NOT_PUBLISHED)은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'NEWSLETTER_PUBLICATION_NOT_PUBLISHED' } }), {
        status: 409, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }),
    });
    expect(resp.status).toBe(409);
  });
});
