import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET, POST } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/channel-posts/drafts (story #3402)', () => {
  it('GET — FastAPI GET /api/v2/organizations/[id]/channel-posts/drafts로 위임', async () => {
    const list = [{ draft_id: 'd1', gate_status: 'approved', publication_status: 'published' }];
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(list));

    const request = new Request('http://test/api/organizations/org-1/channel-posts/drafts');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-posts/drafts', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: list, error: null, meta: null });
  });

  it('GET — !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'org_id mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });

  it('POST — 201로 신규/버전추가 상태 코드를 보존', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk({ draft_id: 'd1', version_id: 'v1' }, 201));
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      expect.anything(), '/api/v2/organizations/[id]/channel-posts/drafts', { id: 'org-1' },
    );
    expect(resp.status).toBe(201);
  });
});
