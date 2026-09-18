import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

describe('/api/organizations/[id]/channel-connections/available-channels (story f30da19a)', () => {
  it('GET — FastAPI available-channels 엔드포인트로 id를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify([
          { channel: 'threads', display_name: 'Threads', credential_kind: 'oauth', kind: 'social' },
          { channel: 'sandbox', display_name: 'Sandbox', credential_kind: 'none', kind: 'social' },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/available-channels', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.data).toHaveLength(2);
  });

  it('GET — org mismatch 403도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'org_id mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });

  it('GET — 에이전트 헤더로 온 요청도 목록을 그대로 통과시킨다(BE가 human 가드를 안 걸어 둔 목록)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const request = new Request('http://test', { headers: { Authorization: 'Bearer agent-key-123' } });
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(200);
  });

  it('GET — 무자격 요청에 대한 BE의 401도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(null, { status: 401 }));
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(401);
  });
});
