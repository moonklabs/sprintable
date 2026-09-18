import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/site-posts/drafts/[draftId]/publish (story #3368/#3369)', () => {
  it('POST — FastAPI POST .../drafts/[draftId]/publish로 위임하고 { data } 봉투로 래핑(실 200, status_code 오버라이드 없음)', async () => {
    const result = { url: 'https://sprintable.ai/ko/blog/2ho-blog', published_at: '2026-09-05T00:00:00Z', version_id: 'v2' };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(result));

    const request = new Request('http://test/api/organizations/org-1/site-posts/drafts/d1/publish', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/site-posts/drafts/[draftId]/publish', { id: 'org-1', draftId: 'd1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('POST — 403/409(승인 미완료·봉인없음·재승인필요) 같은 !ok 응답은 그대로 pass-through(S10 원문 보존)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ data: null, error: { code: 'SITE_POST_SEAL_MISSING', message: 'gate_id=g1' }, meta: null }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(409);
    await expect(resp.json()).resolves.toMatchObject({ error: { code: 'SITE_POST_SEAL_MISSING' } });
  });
});
