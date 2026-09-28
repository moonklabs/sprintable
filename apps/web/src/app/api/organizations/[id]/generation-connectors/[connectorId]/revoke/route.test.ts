import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

describe('/api/organizations/[id]/generation-connectors/[connectorId]/revoke (story #4101 CHANGES-2)', () => {
  it('POST — FastAPI revoke 엔드포인트로 id·connectorId를 그대로 위임', async () => {
    const revoked = { id: 'gc-1', provider_key: 'vertex_gemini', label: '메인', model_config_json: {}, status: 'revoked', created_by: 'u1' };
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify(revoked), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const request = new Request('http://test', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', connectorId: 'gc-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/generation-connectors/[connectorId]/revoke', { id: 'org-1', connectorId: 'gc-1' },
    );
    await expect(resp.json()).resolves.toEqual({ data: revoked, error: null, meta: null });
  });

  it('POST — !ok는 그대로 pass-through(예: 404 커넥터 없음)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'generation connector not found' }), { status: 404 }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', connectorId: 'missing' }) });
    expect(resp.status).toBe(404);
  });
});
