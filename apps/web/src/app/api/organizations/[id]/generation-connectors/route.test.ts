import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/generation-connectors (story #4101)', () => {
  it('GET — FastAPI 목록으로 위임, credentials 필드 없이 그대로 통과', async () => {
    const body = {
      connectors: [
        { id: 'gc-1', provider_key: 'vertex_gemini', label: '메인', model_config_json: {}, status: 'active', created_by: null },
      ],
    };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(body));
    const request = new Request('http://test/api/organizations/org-1/generation-connectors?active_only=true');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(request, '/api/v2/organizations/[id]/generation-connectors', { id: 'org-1' });
    await expect(resp.json()).resolves.toEqual({ data: body, error: null, meta: null });
  });

  it('GET — !ok는 그대로 pass-through(예: 403 org admin 이상만)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'org owner/admin only' }), { status: 403 }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });
});
