import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/insights-board/cost-summary (story #3809)', () => {
  it('GET — FastAPI GET .../insights-board/cost-summary로 위임하고 { data } 봉투로 래핑', async () => {
    const result = {
      ads: {
        approved_boost_count: 1, sealed_ads_currency: 'KRW', sealed_budget_minor: 100_000,
        captured_spend_minor: 12_345, remaining_minor: 87_655, cap_reached_count: 0,
      },
      generation_cost_spent_minor: 5_000,
      generation_cost_period_start: '2026-09-01T00:00:00Z',
      generation_cost_period_end: '2026-09-30T23:59:59Z',
      generation_currency: 'KRW',
      x_cost_spent_minor: null,
      paid_spend_daily_series: [{ date: '2026-09-10', spend_minor: 12_345, source: 'paid' }],
    };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(result));

    const request = new Request('http://test/api/organizations/org-1/insights-board/cost-summary');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/insights-board/cost-summary', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('GET — 403 org_id mismatch(플레인 문자열 detail)도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'org_id mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test/api/organizations/org-1/insights-board/cost-summary'), {
      params: Promise.resolve({ id: 'org-1' }),
    });
    expect(resp.status).toBe(403);
  });
});
