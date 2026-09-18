import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiResponse(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

describe('/api/organizations/[id]/ads-boosts/[gateId]/spend/refresh (story #3806 PR 12)', () => {
  it('POST — FastAPI POST .../spend/refresh로 위임, 성공 응답 { data } 봉투로 래핑', async () => {
    const result = { spend_minor: 12345, captured_at: '2026-09-11T17:30:00Z', cap_reached: false, run_status: 'running' };
    proxyToFastapiWithParams.mockResolvedValue(fastapiResponse(result, 201));

    const request = new Request('http://test/api/organizations/org-1/ads-boosts/gate-1/spend/refresh', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', gateId: 'gate-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/ads-boosts/[gateId]/spend/refresh', { id: 'org-1', gateId: 'gate-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('POST — 429 ADS_SPEND_REFRESH_RATE_LIMITED — Retry-After 헤더 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'ADS_SPEND_REFRESH_RATE_LIMITED', message: '240초 뒤 다시 시도하세요' } }, 429, {
        'Retry-After': '240',
      }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', gateId: 'gate-1' }),
    });
    expect(resp.status).toBe(429);
    expect(resp.headers.get('Retry-After')).toBe('240');
  });

  it('POST — 409 ADS_BOOST_NOT_STARTED(provider 실행 前)도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'ADS_BOOST_NOT_STARTED' } }, 409),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', gateId: 'gate-1' }),
    });
    expect(resp.status).toBe(409);
  });

  it('POST — 403 ADS_BOOST_EXECUTE_HUMAN_ONLY(에이전트 차단)도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'ADS_BOOST_EXECUTE_HUMAN_ONLY' } }, 403),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', gateId: 'gate-1' }),
    });
    expect(resp.status).toBe(403);
  });

  it('POST — 404 ADS_BOOST_GATE_NOT_FOUND도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'ADS_BOOST_GATE_NOT_FOUND' } }, 404),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', gateId: 'gate-1' }),
    });
    expect(resp.status).toBe(404);
  });
});
