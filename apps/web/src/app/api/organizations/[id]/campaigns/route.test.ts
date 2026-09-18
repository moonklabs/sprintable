import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET, POST } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/campaigns (story 1db41045)', () => {
  it('GET — FastAPI GET /api/v2/organizations/[id]/campaigns로 위임하고 { data } 봉투로 래핑', async () => {
    const list = [{
      id: 'c1', name: '9월 캠페인', starts_at: null, ends_at: null, status: 'active',
      created_by_member_id: 'm1', created_at: '2026-09-04T00:00:00+00:00',
    }];
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(list));

    const request = new Request('http://test/api/organizations/org-1/campaigns');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/campaigns', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: list, error: null, meta: null });
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

  it('POST — FastAPI POST /api/v2/organizations/[id]/campaigns로 위임, 201 상태코드 보존', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk({
      id: 'c1', name: '9월 캠페인', starts_at: null, ends_at: null, status: 'active',
      created_by_member_id: 'm1', created_at: '2026-09-04T00:00:00+00:00',
    }, 201));

    const request = new Request('http://test/api/organizations/org-1/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name: '9월 캠페인' }),
    });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/campaigns', { id: 'org-1' },
    );
    expect(resp.status).toBe(201);
    await expect(resp.json()).resolves.toEqual({
      data: {
        id: 'c1', name: '9월 캠페인', starts_at: null, ends_at: null, status: 'active',
        created_by_member_id: 'm1', created_at: '2026-09-04T00:00:00+00:00',
      },
      error: null, meta: null,
    });
  });

  it('POST — 403(CAMPAIGN_CREATE_HUMAN_ONLY, 에이전트 호출)은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ detail: { code: 'CAMPAIGN_CREATE_HUMAN_ONLY', message: 'campaign 생성은 휴먼 멤버만 가능합니다(에이전트는 조회만).' } }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const resp = await POST(new Request('http://test', { method: 'POST', body: '{}' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });
});
