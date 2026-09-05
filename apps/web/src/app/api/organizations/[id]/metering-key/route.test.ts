import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/metering-key (story #3354·#3540 FE)', () => {
  it('GET — FastAPI 응답(public_key)으로 위임, 그대로 통과', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk({ public_key: 'pk_test_1234' }));
    const request = new Request('http://test/api/organizations/org-1/metering-key');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(request, '/api/v2/organizations/[id]/metering-key', { id: 'org-1' });
    await expect(resp.json()).resolves.toEqual({ data: { public_key: 'pk_test_1234' }, error: null, meta: null });
  });

  it('GET — !ok는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(JSON.stringify({ detail: { code: 'INTERNAL' } }), { status: 500 }));
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(500);
  });
});
