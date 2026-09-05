import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function fastapiResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const REPLY_VIEW = {
  id: 'r1', comment_id: 'c1', text: '안내 감사합니다', status: 'pending', gate_id: 'g1',
  external_reply_id: null, external_reply_url: null, last_error: null, target_comment_state: 'current',
};

describe('/api/organizations/[id]/comments/[commentId]/replies/[replyId] (story #3517 조각②)', () => {
  it('GET — FastAPI GET .../replies/{id}로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiResponse(REPLY_VIEW, 200));

    const request = new Request('http://test/api/organizations/org-1/comments/c1/replies/r1');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', commentId: 'c1', replyId: 'r1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/comments/[commentId]/replies/[replyId]', { id: 'org-1', commentId: 'c1', replyId: 'r1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: REPLY_VIEW, error: null, meta: null });
  });

  it('GET — 404 답변 없음은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: '답변을 찾을 수 없습니다: r-404' }, 404),
    );
    const resp = await GET(new Request('http://test'), {
      params: Promise.resolve({ id: 'org-1', commentId: 'c1', replyId: 'r-404' }),
    });
    expect(resp.status).toBe(404);
  });
});
