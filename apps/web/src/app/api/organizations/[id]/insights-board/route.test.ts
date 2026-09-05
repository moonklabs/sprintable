import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/insights-board (story #3503)', () => {
  it('GET — FastAPI GET .../insights-board로 위임하고 { data } 봉투로 래핑', async () => {
    const result = {
      rows: [
        {
          publication_id: 'pub-1', kind: 'channel_publication', channel: 'threads', work_item_id: 'wi-1',
          title: '샘플 글', published_at: '2026-09-01T00:00:00Z', external_url: 'https://example.com/p/1',
          connection_id: 'conn-1',
          d1: { status: 'captured', normalized: { impressions: 100, reach: null, views: 0, engagements: null, clicks: null, spend: null, conversions: null }, captured_at: '2026-09-02T00:00:00Z' },
          d7: null,
        },
      ],
      has_more: false,
      next_cursor: null,
    };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(result));

    const request = new Request('http://test/api/organizations/org-1/insights-board?window=7d');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/insights-board', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('GET — 422 INSIGHTS_BOARD_INVALID_WINDOW는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ detail: { code: 'INSIGHTS_BOARD_INVALID_WINDOW', message: '지원하지 않는 window입니다' } }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const resp = await GET(new Request('http://test/api/organizations/org-1/insights-board?window=bogus'), {
      params: Promise.resolve({ id: 'org-1' }),
    });
    expect(resp.status).toBe(422);
  });

  it('GET — 403 org_id mismatch(플레인 문자열 detail)도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'org_id mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test/api/organizations/org-1/insights-board'), {
      params: Promise.resolve({ id: 'org-1' }),
    });
    expect(resp.status).toBe(403);
  });
});
