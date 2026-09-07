import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/insights/measured-metrics (story #3618)', () => {
  it('GET — FastAPI GET .../insights/measured-metrics로 위임하고 { data } 봉투로 래핑', async () => {
    const result = {
      utm_attribution_rate: { value: 0.3, numerator: 30, denominator: 100, reason_code: null },
      comment_miss_rate: { value: null, numerator: 0, denominator: 0, reason_code: 'NO_COMMENT_DATA' },
      follow_up_creation_rate: { value: 0, numerator: 0, denominator: 5, reason_code: null },
      computed_at: '2026-09-07T00:00:00Z',
    };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(result));

    const request = new Request('http://test/api/organizations/org-1/insights/measured-metrics?days=7');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/insights/measured-metrics', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('GET — 422 MEASURED_METRICS_INVALID_DAYS는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 'MEASURED_METRICS_INVALID_DAYS', message: 'days는 7 또는 30만 허용합니다.' } }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const resp = await GET(new Request('http://test/api/organizations/org-1/insights/measured-metrics?days=14'), {
      params: Promise.resolve({ id: 'org-1' }),
    });
    expect(resp.status).toBe(422);
  });

  it('GET — 403 org_id mismatch도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'org_id mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test/api/organizations/org-1/insights/measured-metrics'), {
      params: Promise.resolve({ id: 'org-1' }),
    });
    expect(resp.status).toBe(403);
  });
});
