import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/site-posts (story #3368, 발행)', () => {
  // ⭐라이브 dev 검증(2026-09-03, 페드루 지시 ①)에서 잡힌 실사고 — site_posts.py::
  // post_site_post는 status_code=201인데 이 테스트가 최초엔 200으로 mock해 그 드롭을
  // 못 잡았다(drafts POST 라우트에서 이미 한 번 겪은 같은 패턴). 이제 201로 고정한다.
  it('⭐POST — FastAPI POST /api/v2/organizations/[id]/site-posts로 위임하고 실 201을 보존한 채 { data } 봉투로 래핑', async () => {
    const result = { id: 'p1', slug: '2ho-blog', title: '2호 글', lang: 'ko', published_at: '2026-09-05T00:00:00Z', gate_id: 'g1' };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(result, 201));

    const request = new Request('http://test/api/organizations/org-1/site-posts', {
      method: 'POST', body: JSON.stringify({ work_item_id: 'w1', gate_id: 'g1', title: 't', slug: 's', lang: 'ko', summary: 'sm', tags: [], body_md: 'b' }),
    });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/site-posts', { id: 'org-1' },
    );
    expect(resp.status).toBe(201);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('POST — 403(게이트 미승인·휴먼 전용) 같은 !ok 응답은 그대로 pass-through(S10 원문 보존)', async () => {
    // 실 dev 백엔드 curl 실측(2026-09-03) — 에러 바디는 FastAPI 기본 {detail:...}가 아니라
    // 전역 예외 핸들러가 {data:null, error:{code,message}, meta:null}로 감싼다. 이 라우트는
    // 바디를 안 건드리고 그대로 pass-through하므로 shape 자체는 이 테스트의 관심사가
    // 아니지만(status만 확인), 실물과 맞춰 둔다 — api-error.ts::parseSitePostApiError가
    // 소비하는 실제 shape이 이것이다.
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ data: null, error: { code: 'SITE_POST_PUBLISH_HUMAN_ONLY', message: '글 공개는 휴먼 멤버만 가능합니다' }, meta: null }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
    await expect(resp.json()).resolves.toMatchObject({ error: { code: 'SITE_POST_PUBLISH_HUMAN_ONLY' } });
  });
});
