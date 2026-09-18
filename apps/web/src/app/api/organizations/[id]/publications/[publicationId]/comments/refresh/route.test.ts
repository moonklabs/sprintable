import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiResponse(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

describe('/api/organizations/[id]/publications/[publicationId]/comments/refresh (story #3517)', () => {
  it('POST — FastAPI POST .../comments/refresh로 위임, 성공 응답 그대로', async () => {
    const result = { fetched: 5, deleted: 1, captured_at: '2026-09-05T12:00:00Z' };
    proxyToFastapiWithParams.mockResolvedValue(fastapiResponse(result, 200));

    const request = new Request('http://test/api/organizations/org-1/publications/pub-1/comments/refresh', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/publications/[publicationId]/comments/refresh', { id: 'org-1', publicationId: 'pub-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  // story #3517(PO 지적, 2026-09-05) — 이 테스트는 proxyToFastapiWithParams 자체를
  // mock하므로 "route가 그 반환값을 그대로 넘긴다"만 잰다 — 실제 fastapi-proxy.ts의
  // Retry-After 허용목록 통과 여부는 fastapi-proxy.test.ts(실 fetch stub)가 잰다.
  // 이름이 "보존된다"라고 약속한 걸 이 테스트 혼자로는 못 지켜 이름을 정정한다.
  it('POST — 429 COMMENT_REFRESH_RATE_LIMITED — route는 proxyToFastapiWithParams 반환 헤더를 그대로 넘긴다(허용목록 통과 자체는 fastapi-proxy.test.ts에서)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'COMMENT_REFRESH_RATE_LIMITED', message: '잠시 후 다시 시도해 주세요' } }, 429, { 'Retry-After': '60' }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }),
    });
    expect(resp.status).toBe(429);
    expect(resp.headers.get('Retry-After')).toBe('60');
  });

  it('POST — 422 COMMENT_COLLECTION_UNSUPPORTED도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'COMMENT_COLLECTION_UNSUPPORTED', message: '이 채널은 댓글 수집을 지원하지 않습니다' } }, 422),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }),
    });
    expect(resp.status).toBe(422);
  });

  it('POST — 403 COMMENT_REFRESH_HUMAN_ONLY(에이전트 차단)도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'COMMENT_REFRESH_HUMAN_ONLY', message: '사람만 다시 수집할 수 있습니다' } }, 403),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }),
    });
    expect(resp.status).toBe(403);
  });

  it('POST — 502(채널 fetch 실패)도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ code: 'CHANNEL_FETCH_FAILED', message: '채널에서 응답을 받지 못했습니다' }, 502),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }),
    });
    expect(resp.status).toBe(502);
  });
});
