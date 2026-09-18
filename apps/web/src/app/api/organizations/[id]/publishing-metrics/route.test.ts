import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

describe('/api/organizations/[id]/publishing-metrics (story #3484)', () => {
  it('GET — FastAPI 발행 계측 엔드포인트로 id를 그대로 위임(쿼리는 proxyToFastapi가 통째로 전달)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({
          window: '7d', on_time_rate: 0.95, on_time_numer: 19, on_time_denom: 20,
          duplicate_publications: 0, unapproved_adapter_calls: 0,
          recovery_seconds_p50: 120, recovery_seconds_p95: 600,
          connections_expired: 0, connections_expiring_7d: 1, computed_at: '2026-09-05T00:00:00Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test?window=7d', { method: 'GET' });
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/publishing-metrics', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
  });

  it('GET — BE의 !ok 응답을 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'SOME_ERROR' } }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await GET(new Request('http://test?window=30d', { method: 'GET' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(500);
  });
});
