import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/publications/[publicationId]/insights (story #3499)', () => {
  it('GET — FastAPI GET .../insights로 위임하고 { data } 봉투로 래핑', async () => {
    const result = [
      {
        normalized: {
          impressions: 100, reach: null, views: 50, engagements: 0, clicks: null, spend: null, conversions: null,
        },
        captured_at: '2026-09-06T00:00:00Z', status: 'captured', due_at: '2026-09-06T00:00:00Z', source: 'threads',
      },
    ];
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(result));

    const request = new Request('http://test/api/organizations/org-1/publications/pub-1/insights');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/publications/[publicationId]/insights', { id: 'org-1', publicationId: 'pub-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('GET — publication 자체가 없으면(404) 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: '발행을 찾을 수 없습니다' }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }) });
    expect(resp.status).toBe(404);
  });
});
