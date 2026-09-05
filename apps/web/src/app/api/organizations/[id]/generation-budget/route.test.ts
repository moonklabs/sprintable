import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

describe('/api/organizations/[id]/generation-budget (story #3500, BE #3498 미착지 — fixture)', () => {
  it('GET — FastAPI 잔량 조회 엔드포인트로 id를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({
          limit_minor: 100000, spent_minor: 20000, remaining_minor: 80000, currency: 'KRW', period: 'month',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', { method: 'GET' });
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/generation-budget', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.data.remaining_minor).toBe(80000);
  });

  it('GET — 정책 미설정(limit_minor=null)도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ limit_minor: null, spent_minor: 0, remaining_minor: null, currency: null, period: 'month' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const resp = await GET(new Request('http://test', { method: 'GET' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.data.limit_minor).toBeNull();
  });

  it('GET — BE 404/미착지 응답도 삼키지 않고 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await GET(new Request('http://test', { method: 'GET' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(404);
  });
});
