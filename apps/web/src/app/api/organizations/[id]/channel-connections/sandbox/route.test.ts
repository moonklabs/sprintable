import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

describe('/api/organizations/[id]/channel-connections/sandbox (story 5b27b32f)', () => {
  it('POST — FastAPI 샌드박스 연결 생성 엔드포인트로 id를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'c1', channel: 'sandbox', account_id: 'sandbox-org-1', status: 'active' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/sandbox', { id: 'org-1' },
    );
    expect(resp.status).toBe(201);
  });

  it('POST — 404(CHANNEL_SANDBOX_DISABLED, 어댑터 미등재) 같은 !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_SANDBOX_DISABLED' } }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(404);
  });

  it('POST — 에이전트 헤더로 온 요청도 BE의 CHANNEL_CONNECTION_HUMAN_ONLY 403을 그대로 통과시킨다(삼키지 않음)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_CONNECTION_HUMAN_ONLY' } }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const request = new Request('http://test', { method: 'POST', headers: { Authorization: 'Bearer agent-key-123' } });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });

  it('POST — member(owner/admin 아님) 요청에 대한 BE의 OWNER_OR_ADMIN_ONLY 403도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_CONNECTION_OWNER_OR_ADMIN_ONLY' } }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });

  it('POST — 무자격 요청에 대한 BE의 401도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(null, { status: 401 }));
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(401);
  });
});
