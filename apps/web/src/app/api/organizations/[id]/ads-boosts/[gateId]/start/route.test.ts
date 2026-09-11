import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/ads-boosts/[gateId]/start (story #3806)', () => {
  it('POST — FastAPI POST .../start로 위임하고 { data } 봉투로 래핑', async () => {
    const result = { command_id: 'cmd-1', operation: 'boost_start', toggle_seq: 0, status: 'pending' };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(result, 201));

    const request = new Request('http://test/api/organizations/org-1/ads-boosts/gate-1/start', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', gateId: 'gate-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/ads-boosts/[gateId]/start', { id: 'org-1', gateId: 'gate-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('POST — 미승인 게이트(409)는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'ADS_BOOST_GATE_NOT_APPROVED' } }), {
        status: 409, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', gateId: 'gate-1' }),
    });
    expect(resp.status).toBe(409);
  });
});
