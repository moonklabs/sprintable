import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/publications/[publicationId]/follow-ups (story #3503)', () => {
  it('POST — FastAPI POST .../follow-ups로 위임하고 201을 그대로 유지', async () => {
    const result = { story_id: 'story-1' };
    proxyToFastapiWithParams.mockResolvedValue(fastapiResponse(result, 201));

    const request = new Request('http://test/api/organizations/org-1/publications/pub-1/follow-ups', {
      method: 'POST', body: JSON.stringify({ kind: 'republish' }),
    });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/publications/[publicationId]/follow-ups', { id: 'org-1', publicationId: 'pub-1' },
    );
    expect(resp.status).toBe(201);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('POST — 403 FOLLOW_UP_CREATE_HUMAN_ONLY(에이전트 차단)는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'FOLLOW_UP_CREATE_HUMAN_ONLY', message: '사람만 후속 조치를 만들 수 있습니다' } }, 403),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }),
    });
    expect(resp.status).toBe(403);
  });

  it('POST — 404 publication 없음(플레인 문자열 detail)도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: 'publication을 찾을 수 없습니다: pub-404' }, 404),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', publicationId: 'pub-404' }),
    });
    expect(resp.status).toBe(404);
  });

  it('POST — 422 FOLLOW_UP_INVALID_KIND도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'FOLLOW_UP_INVALID_KIND', message: '알 수 없는 kind입니다' } }, 422),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }),
    });
    expect(resp.status).toBe(422);
  });
});
