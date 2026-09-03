import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/site-posts/drafts/[draftId]/versions (story #3368)', () => {
  it('GET — FastAPI GET .../drafts/[draftId]/versions로 위임하고 { data } 봉투로 래핑', async () => {
    const versions = [
      { version_id: 'v1', version: 1, slug: 's', source_story_id: 'w1', title: 't1', lang: 'ko', summary: 's1', tags: [], body_md: 'b1', body_sha256: 'h1', author_member_id: 'm1', author_kind: 'agent', created_at: 't' },
    ];
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(versions));

    const request = new Request('http://test/api/organizations/org-1/site-posts/drafts/d1/versions');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/site-posts/drafts/[draftId]/versions', { id: 'org-1', draftId: 'd1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: versions, error: null, meta: null });
  });

  it('GET — 404(draft not found) 같은 !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'draft not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', draftId: 'missing' }) });
    expect(resp.status).toBe(404);
  });
});
