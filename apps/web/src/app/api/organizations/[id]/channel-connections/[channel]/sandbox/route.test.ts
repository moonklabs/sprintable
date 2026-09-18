import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

describe('/api/organizations/[id]/channel-connections/[channel]/sandbox (story #3523)', () => {
  it('POST — FastAPI 범용 샌드박스 엔드포인트로 id·channel을 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'c1', channel: 'instagram_sandbox', account_id: 'instagram-sandbox-org-1', status: 'active' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', channel: 'instagram_sandbox' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/[channel]/sandbox', { id: 'org-1', channel: 'instagram_sandbox' },
    );
    expect(resp.status).toBe(201);
    await expect(resp.json()).resolves.toMatchObject({ data: { channel: 'instagram_sandbox' } });
  });

  it('POST — 404(CHANNEL_SANDBOX_DISABLED, 어댑터 미등재)는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'CHANNEL_SANDBOX_DISABLED' } }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', channel: 'instagram_sandbox' }),
    });
    expect(resp.status).toBe(404);
  });

  // story #3523 — 이 신규 라우트가 있는 이유 그 자체(PO 실측 결함 클래스)의
  // 회귀가드: credential_kind가 'none'이 아닌 채널(예: threads)을 이 경로로 부르면
  // BE가 422 CHANNEL_SANDBOX_UNSUPPORTED로 거부한다 — 이 BFF는 그것도 그대로 통과시켜야
  // 한다(여기서 재해석·삼킴 0).
  it('POST — 422(CHANNEL_SANDBOX_UNSUPPORTED, credential_kind 불일치)도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'CHANNEL_SANDBOX_UNSUPPORTED' } }), {
        status: 422, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', channel: 'threads' }),
    });
    expect(resp.status).toBe(422);
  });

  it('POST — member(owner/admin 아님) 요청에 대한 BE의 OWNER_OR_ADMIN_ONLY 403도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'CHANNEL_CONNECTION_OWNER_OR_ADMIN_ONLY' } }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', channel: 'sandbox' }),
    });
    expect(resp.status).toBe(403);
  });

  it('POST — 무자격 요청에 대한 BE의 401도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(null, { status: 401 }));
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', channel: 'sandbox' }),
    });
    expect(resp.status).toBe(401);
  });
});
