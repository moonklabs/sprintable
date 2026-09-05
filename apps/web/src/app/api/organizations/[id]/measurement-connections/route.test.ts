import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/measurement-connections (story #3540)', () => {
  it('GET — FastAPI 목록으로 위임, 그대로 통과', async () => {
    const list = [
      { key: 'beacon', status: 'not_started', last_seen_at: null, count_7d: null, settings_path: null },
      { key: 'utm', status: 'off', last_seen_at: null, count_7d: null, settings_path: '/organization/content-rules' },
    ];
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(list));
    const request = new Request('http://test/api/organizations/org-1/measurement-connections');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(request, '/api/v2/organizations/[id]/measurement-connections', { id: 'org-1' });
    await expect(resp.json()).resolves.toEqual({ data: list, error: null, meta: null });
  });

  it('GET — !ok는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(JSON.stringify({ detail: { code: 'INTERNAL' } }), { status: 500 }));
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(500);
  });
});
