import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

describe('/api/organizations/[id]/channel-posts/drafts/[draftId]/unpublish (story #3426)', () => {
  it('POST — FastAPI unpublish 엔드포인트로 draftId를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ publication_id: 'p1', status: 'unpublished', external_id: 'm1', unpublished_at: '2026-09-04T00:00:00Z' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const request = new Request('http://test', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/unpublish', { id: 'org-1', draftId: 'd1' },
    );
    expect(resp.status).toBe(200);
  });

  it('POST — 422(CHANNEL_SCOPE_INSUFFICIENT, required_scopes 동봉) 같은 !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_SCOPE_INSUFFICIENT', required_scopes: ['threads_delete'] } }), {
        status: 422, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(422);
  });

  it('POST — 409(CHANNEL_POST_NOT_PUBLISHED) 같은 !ok 응답도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_POST_NOT_PUBLISHED' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(409);
  });

  it('POST — 502(CHANNEL_PUBLISH_PROVIDER_ERROR) 같은 !ok 응답도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_PUBLISH_PROVIDER_ERROR' } }), { status: 502, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(502);
  });

  it('POST — 에이전트 헤더로 온 요청도 BE의 CANCEL_UNPUBLISH_HUMAN_ONLY 403을 그대로 통과시킨다(삼키지 않음)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_POST_CANCEL_UNPUBLISH_HUMAN_ONLY' } }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const request = new Request('http://test', { method: 'POST', headers: { Authorization: 'Bearer agent-key-123' } });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(403);
  });

  it('POST — member(owner/admin 아님) 요청에 대한 BE의 OWNER_OR_ADMIN_ONLY 403도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_POST_CANCEL_UNPUBLISH_OWNER_OR_ADMIN_ONLY' } }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(403);
  });

  it('POST — 무자격 요청에 대한 BE의 401도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(null, { status: 401 }));
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(401);
  });
});
