import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET, POST } from './route';

function fastapiOk(body: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('/api/organizations/[id]/site-posts/drafts (story #3368)', () => {
  it('GET — FastAPI GET /api/v2/organizations/[id]/site-posts/drafts로 위임하고 { data } 봉투로 래핑', async () => {
    const list = [{
      draft_id: 'd1', work_item_id: 'w1', slug: '2ho-blog', lang: 'ko', title: '2호 글',
      current_version: 2, latest_author_kind: 'human', updated_at: '2026-09-03T03:52:00+00:00',
    }];
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(list));

    const request = new Request('http://test/api/organizations/org-1/site-posts/drafts');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/site-posts/drafts', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
    // story #3744(페드루 스티어) — meta.total(api/stories/route.ts:69 관례 재사용,
    // totalCount 아님). X-Total-Count 미제공 시 meta 자체가 null.
    await expect(resp.json()).resolves.toEqual({ data: list, error: null, meta: null });
  });

  // story #3744(페드루 스티어) — X-Total-Count → meta.total(부분 상태 표기용).
  it('GET — X-Total-Count 헤더가 있으면 meta.total로 실린다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk([], 200, { 'X-Total-Count': '42' }));
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    await expect(resp.json()).resolves.toEqual({ data: [], error: null, meta: { total: 42 } });
  });

  it('GET — X-Total-Count 헤더가 없으면 meta 자체가 null("모른다"·0으로 위장 안 함)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk([]));
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    await expect(resp.json()).resolves.toEqual({ data: [], error: null, meta: null });
  });

  // 뮤테이션 표적 — Number.isFinite 가드를 지우면 헤더가 숫자 아닐 때 NaN이 JSON
  // 직렬화에서 null이 돼 "모른다"와 구분이 안 되지만, 그 경로도 결국 meta:null로
  // 떨어지긴 한다 — 진짜 표적은 "숫자 헤더를 실제로 파싱하는지"다(항상 undefined를
  // 반환하는 구현도 이 값 하나만으론 못 잡으므로 유한값 케이스를 명시로 잰다, 위 42 테스트).
  it('GET — 헤더 값이 숫자가 아니면(계약 위반) meta:null로 떨어진다(진짜 아님을 위장 안 함)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk([], 200, { 'X-Total-Count': 'not-a-number' }));
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    await expect(resp.json()).resolves.toEqual({ data: [], error: null, meta: null });
  });

  it('GET — 0건도 빈 배열로 정상 통과(에러 아님)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk([]));
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    await expect(resp.json()).resolves.toEqual({ data: [], error: null, meta: null });
  });

  it('GET — !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'org_id mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });

  it('POST — FastAPI POST /api/v2/organizations/[id]/site-posts/drafts로 위임(신규/버전추가 동일 엔드포인트)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk({ draft_id: 'd1', version_id: 'v2', version: 2 }, 201));

    const request = new Request('http://test/api/organizations/org-1/site-posts/drafts', {
      method: 'POST',
      body: JSON.stringify({ work_item_id: 'w1', slug: '2ho-blog', lang: 'ko', title: 't', summary: 's', tags: [], body_md: 'b', media_manifest: [] }),
    });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/site-posts/drafts', { id: 'org-1' },
    );
    expect(resp.status).toBe(201);
    await expect(resp.json()).resolves.toEqual({ data: { draft_id: 'd1', version_id: 'v2', version: 2 }, error: null, meta: null });
  });

  it('POST — 422(media 지원 안함) 같은 !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'MEDIA_NOT_SUPPORTED_PHASE0' } }), { status: 422, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(422);
  });
});
