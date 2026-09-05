import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const REPLY_VIEW = {
  id: 'r1', comment_id: 'c1', text: '안내 감사합니다', status: 'draft', gate_id: null,
  external_reply_id: null, external_reply_url: null, last_error: null, target_comment_state: null,
};

describe('/api/organizations/[id]/comments/[commentId]/replies (story #3517 조각②)', () => {
  it('POST — FastAPI POST .../replies로 위임하고 201을 그대로 유지', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiResponse(REPLY_VIEW, 201));

    const request = new Request('http://test/api/organizations/org-1/comments/c1/replies', {
      method: 'POST', body: JSON.stringify({ text: '안내 감사합니다' }),
    });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', commentId: 'c1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/comments/[commentId]/replies', { id: 'org-1', commentId: 'c1' },
    );
    expect(resp.status).toBe(201);
    await expect(resp.json()).resolves.toEqual({ data: REPLY_VIEW, error: null, meta: null });
  });

  it('POST — 404 댓글 없음은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: '댓글을 찾을 수 없습니다: c-404' }, 404),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', commentId: 'c-404' }),
    });
    expect(resp.status).toBe(404);
  });
});
