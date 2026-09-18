import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/site-posts/drafts/[draftId]/publication (story #3386, S8)', () => {
  it('GET — FastAPI GET .../publication으로 위임하고 { data } 봉투로 래핑', async () => {
    const result = {
      published_at: '2026-09-03T18:44:00Z', url: 'https://sprintable.ai/ko/blog/2ho-blog',
      published_by_member_id: 'm1', published_body_sha256: 'h1',
    };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(result));

    const request = new Request('http://test/api/organizations/org-1/site-posts/drafts/d1/publication');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/site-posts/drafts/[draftId]/publication', { id: 'org-1', draftId: 'd1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('GET — draft 자체가 없으면(404) 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: '드래프트를 찾을 수 없습니다' }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(404);
  });
});
