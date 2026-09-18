import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/ads-boosts/[gateId]/spend (story #3806)', () => {
  it('GET — FastAPI GET .../spend로 위임하고 { data } 봉투로 래핑', async () => {
    const result = {
      gate_id: 'gate-1', sealed_ads_budget_minor: 100_000, sealed_ads_currency: 'KRW',
      captured_spend_minor: 24_690, remaining_minor: 75_310, run_status: 'running',
      snapshots: [
        { due_at: '2026-09-13T00:00:00Z', captured_at: '2026-09-13T00:01:00Z', status: 'captured', spend_minor: 12_345 },
        { due_at: '2026-09-19T00:00:00Z', captured_at: null, status: 'pending', spend_minor: null },
      ],
    };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(result));

    const request = new Request('http://test/api/organizations/org-1/ads-boosts/gate-1/spend');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', gateId: 'gate-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/ads-boosts/[gateId]/spend', { id: 'org-1', gateId: 'gate-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('GET — 미존재 게이트(404)는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'ADS_BOOST_GATE_NOT_FOUND' } }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', gateId: 'gate-1' }) });
    expect(resp.status).toBe(404);
  });
});
