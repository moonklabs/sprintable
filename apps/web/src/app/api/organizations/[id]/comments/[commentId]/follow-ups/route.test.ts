import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/comments/[commentId]/follow-ups (story #3517 조각②)', () => {
  it('POST — FastAPI POST .../follow-ups로 위임하고 201을 그대로 유지', async () => {
    const result = { story_id: 'story-1' };
    proxyToFastapiWithParams.mockResolvedValue(fastapiResponse(result, 201));

    const request = new Request('http://test/api/organizations/org-1/comments/c1/follow-ups', {
      method: 'POST', body: JSON.stringify({ title: '[댓글] 제목', note: null }),
    });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', commentId: 'c1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/comments/[commentId]/follow-ups', { id: 'org-1', commentId: 'c1' },
    );
    expect(resp.status).toBe(201);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('POST — 403 COMMENT_REPLY_HUMAN_ONLY(에이전트 차단)는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'COMMENT_REPLY_HUMAN_ONLY', message: '이 액션은 휴먼 멤버만 가능합니다.' } }, 403),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', commentId: 'c1' }),
    });
    expect(resp.status).toBe(403);
  });

  it('POST — 404 댓글 없음도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: '댓글을 찾을 수 없습니다: c-404' }, 404),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', commentId: 'c-404' }),
    });
    expect(resp.status).toBe(404);
  });
});
