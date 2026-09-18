import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const REPLY_VIEW = {
  id: 'r1', comment_id: 'c1', text: '안내 감사합니다', status: 'pending', gate_id: 'g1',
  external_reply_id: null, external_reply_url: null, last_error: null, target_comment_state: 'current',
};

describe('/api/organizations/[id]/comments/[commentId]/replies/[replyId]/submit (story #3517 조각②)', () => {
  it('POST — FastAPI POST .../submit으로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiResponse(REPLY_VIEW, 200));

    const request = new Request('http://test/api/organizations/org-1/comments/c1/replies/r1/submit', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', commentId: 'c1', replyId: 'r1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/comments/[commentId]/replies/[replyId]/submit', { id: 'org-1', commentId: 'c1', replyId: 'r1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: REPLY_VIEW, error: null, meta: null });
  });

  it('POST — 403 COMMENT_REPLY_HUMAN_ONLY는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'COMMENT_REPLY_HUMAN_ONLY', message: '이 액션은 휴먼 멤버만 가능합니다.' } }, 403),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', commentId: 'c1', replyId: 'r1' }),
    });
    expect(resp.status).toBe(403);
  });

  it('POST — 422 COMMENT_REPLY_WRONG_STATUS는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'COMMENT_REPLY_WRONG_STATUS', message: '이 상태(pending)에서는 상신할 수 없습니다' } }, 422),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', commentId: 'c1', replyId: 'r1' }),
    });
    expect(resp.status).toBe(422);
  });

  it('POST — 409 COMMENT_REPLY_TARGET_DELETED는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'COMMENT_REPLY_TARGET_DELETED', message: '답변 대상 댓글이 삭제되어 상신할 수 없습니다.' } }, 409),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', commentId: 'c1', replyId: 'r1' }),
    });
    expect(resp.status).toBe(409);
  });

  it('POST — 422 COMMENT_REPLY_CHANNEL_UNSUPPORTED는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'COMMENT_REPLY_CHANNEL_UNSUPPORTED', message: '이 채널은 답변 발송을 지원하지 않습니다.' } }, 422),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', commentId: 'c1', replyId: 'r1' }),
    });
    expect(resp.status).toBe(422);
  });
});
