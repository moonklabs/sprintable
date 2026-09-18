import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

describe('/api/organizations/[id]/channel-posts/drafts/[draftId]/publish (story #3402)', () => {
  it('POST — FastAPI publish 엔드포인트로 draftId를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ permalink: 'https://x', external_id: 'm1', published_at: '2026-09-03T00:00:00Z' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const request = new Request('http://test', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/publish', { id: 'org-1', draftId: 'd1' },
    );
    expect(resp.status).toBe(200);
  });

  it('POST — 409(CHANNEL_PUBLISH_IN_PROGRESS, story #3395) 같은 !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_PUBLISH_IN_PROGRESS' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(409);
  });

  // 카디르 QA(2026-09-04)·페드루 PO 방향 정정 — 경계는 BE다(publish는 CHANNEL_POST_
  // PUBLISH_HUMAN_ONLY 403을 이미 강제). BFF에 별도 세션전용 가드를 새로 세우지 않는다
  // (fastapi-proxy.ts::resolveAuthHeader가 세션/에이전트 자격을 플랫폼 전체에서 동등하게
  // 다루는 얇은 프록시 — 이 라우트만 다르게 만들면 다른 BFF 라우트와 어긋난다). 대신 BE가
  // 낸 403/401을 이 라우트가 «삼키지 않고» 그대로 통과시키는지만 pin한다.
  it('POST — 에이전트 헤더로 온 요청도 BE의 CHANNEL_POST_PUBLISH_HUMAN_ONLY 403을 그대로 통과시킨다(삼키지 않음)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_POST_PUBLISH_HUMAN_ONLY' } }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const request = new Request('http://test', { method: 'POST', headers: { Authorization: 'Bearer agent-key-123' } });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(403);
  });

  it('POST — 무자격 요청에 대한 BE의 401도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(null, { status: 401 }));
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(401);
  });
});
