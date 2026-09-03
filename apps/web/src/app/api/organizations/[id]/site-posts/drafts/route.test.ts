import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET, POST } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/site-posts/drafts (story #3368)', () => {
  it('GET — FastAPI GET /api/v2/organizations/[id]/site-posts/drafts로 위임하고 { data } 봉투로 래핑', async () => {
    const list = [{
      draft_id: 'd1', work_item_id: 'w1', slug: '2ho-blog', lang: 'ko', title: '2호 글',
      current_version: 2, latest_author_kind: 'human', updated_at: '2026-09-03T03:52:00+00:00',
    }];
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(list));

    const request = new Request('http://test/api/organizations/org-1/site-posts/drafts');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/site-posts/drafts', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: list, error: null, meta: null });
  });

  it('GET — 0건도 빈 배열로 정상 통과(에러 아님)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk([]));
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    await expect(resp.json()).resolves.toEqual({ data: [], error: null, meta: null });
  });

  it('GET — !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'org_id mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });

  it('POST — FastAPI POST /api/v2/organizations/[id]/site-posts/drafts로 위임(신규/버전추가 동일 엔드포인트)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk({ draft_id: 'd1', version_id: 'v2', version: 2 }, 201));

    const request = new Request('http://test/api/organizations/org-1/site-posts/drafts', {
      method: 'POST',
      body: JSON.stringify({ work_item_id: 'w1', slug: '2ho-blog', lang: 'ko', title: 't', summary: 's', tags: [], body_md: 'b', media_manifest: [] }),
    });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/site-posts/drafts', { id: 'org-1' },
    );
    expect(resp.status).toBe(201);
    await expect(resp.json()).resolves.toEqual({ data: { draft_id: 'd1', version_id: 'v2', version: 2 }, error: null, meta: null });
  });

  it('POST — 422(media 지원 안함) 같은 !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'MEDIA_NOT_SUPPORTED_PHASE0' } }), { status: 422, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(422);
  });
});
