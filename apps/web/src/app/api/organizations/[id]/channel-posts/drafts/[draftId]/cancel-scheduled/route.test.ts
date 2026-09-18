import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

describe('/api/organizations/[id]/channel-posts/drafts/[draftId]/cancel-scheduled (story #3426)', () => {
  it('POST — FastAPI cancel-scheduled 엔드포인트로 draftId를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ command_id: 'c1', status: 'cancelled', reason_code: null }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const request = new Request('http://test', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/cancel-scheduled', { id: 'org-1', draftId: 'd1' },
    );
    expect(resp.status).toBe(200);
  });

  it('POST — 409(PUBLICATION_COMMAND_NOT_CANCELLABLE, current_status 동봉) 같은 !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'PUBLICATION_COMMAND_NOT_CANCELLABLE', current_status: 'in_progress' } }), {
        status: 409, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(409);
  });

  it('POST — 404(PUBLICATION_COMMAND_NOT_FOUND) 같은 !ok 응답도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'PUBLICATION_COMMAND_NOT_FOUND' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(404);
  });

  // story #3402 PR2 QA/PO 정정과 동형 관례 — 경계는 BE다(_require_owner_or_admin이
  // CHANNEL_POST_CANCEL_UNPUBLISH_HUMAN_ONLY/OWNER_OR_ADMIN_ONLY 403을 이미 강제).
  // BFF에 별도 세션전용 가드를 세우지 않고, BE가 낸 403/401을 그대로 통과시키는지만 pin.
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
