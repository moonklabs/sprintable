import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function fastapiResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/publications/[publicationId]/comments (story #3517, insights 미러)', () => {
  it('GET — FastAPI GET .../comments로 위임(limit/offset은 원 요청 querystring이 그대로 실려간다)', async () => {
    const result = { last_collected_at: '2026-09-05T10:00:00Z', comments: [], active_count: 0, deleted_count: 0 };
    proxyToFastapiWithParams.mockResolvedValue(fastapiResponse(result, 200));

    const request = new Request('http://test/api/organizations/org-1/publications/pub-1/comments?limit=50&offset=0');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/publications/[publicationId]/comments', { id: 'org-1', publicationId: 'pub-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('GET — 404 publication 없음도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiResponse({ detail: 'publication을 찾을 수 없습니다: pub-404' }, 404));
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', publicationId: 'pub-404' }) });
    expect(resp.status).toBe(404);
  });

  it('GET — 401 무자격도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(null, { status: 401 }));
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }) });
    expect(resp.status).toBe(401);
  });
});
