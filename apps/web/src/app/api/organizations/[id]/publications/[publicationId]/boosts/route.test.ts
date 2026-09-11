import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/publications/[publicationId]/boosts (story #3806)', () => {
  it('POST — FastAPI POST .../boosts로 위임하고 { data } 봉투로 래핑', async () => {
    const result = {
      gate_id: 'gate-1', status: 'pending', reapproval_required: false,
      sealed_ads_connection_id: 'conn-1', sealed_ads_budget_minor: 100_000, sealed_ads_currency: 'KRW',
      sealed_ads_starts_at: '2026-09-12T00:00:00Z', sealed_ads_ends_at: '2026-09-19T00:00:00Z',
      sealed_ads_objective: 'POST_ENGAGEMENT',
    };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(result, 201));

    const request = new Request('http://test/api/organizations/org-1/publications/pub-1/boosts', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/publications/[publicationId]/boosts', { id: 'org-1', publicationId: 'pub-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('POST — 예산 봉인 초과(422)는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'ADS_BUDGET_EXCEEDS_SEAL' } }), {
        status: 422, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }),
    });
    expect(resp.status).toBe(422);
  });
});
