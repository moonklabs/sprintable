import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

describe('/api/organizations/[id]/site-posts/drafts/[draftId]/variants (story 15e481ce)', () => {
  it('GET — FastAPI variants 엔드포인트로 contentItemId를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify([{ draft_id: 'd1', channel: 'threads', current_version: 1 }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', draftId: 'content-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/site-posts/drafts/[contentItemId]/variants', { id: 'org-1', contentItemId: 'content-1' },
    );
    expect(resp.status).toBe(200);
  });

  it('GET — 원문을 찾을 수 없는 404도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: '원문을 찾을 수 없습니다: content-1' }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', draftId: 'content-1' }) });
    expect(resp.status).toBe(404);
  });

  it('GET — org mismatch 403도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'org_id mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', draftId: 'content-1' }) });
    expect(resp.status).toBe(403);
  });

  it('GET — 무자격 요청에 대한 BE의 401도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(null, { status: 401 }));
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', draftId: 'content-1' }) });
    expect(resp.status).toBe(401);
  });
});
