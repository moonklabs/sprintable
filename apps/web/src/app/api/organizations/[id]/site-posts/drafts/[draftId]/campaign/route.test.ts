import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { PATCH } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/site-posts/drafts/[draftId]/campaign (story 1db41045)', () => {
  it('PATCH — FastAPI PATCH .../campaign로 위임하고 {data} 봉투로 래핑', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk({ draft_id: 'd1', campaign_id: 'c1', campaign_name: '9월 캠페인' }));
    const request = new Request('http://test', { method: 'PATCH', body: JSON.stringify({ campaign_id: 'c1' }) });
    const resp = await PATCH(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/site-posts/drafts/[draftId]/campaign', { id: 'org-1', draftId: 'd1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: { draft_id: 'd1', campaign_id: 'c1', campaign_name: '9월 캠페인' }, error: null, meta: null });
  });

  it('PATCH — campaign_id: null(해제)도 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk({ draft_id: 'd1', campaign_id: null, campaign_name: null }));
    const request = new Request('http://test', { method: 'PATCH', body: JSON.stringify({ campaign_id: null }) });
    const resp = await PATCH(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    await expect(resp.json()).resolves.toEqual({ data: { draft_id: 'd1', campaign_id: null, campaign_name: null }, error: null, meta: null });
  });

  it('PATCH — 422(CAMPAIGN_NOT_FOUND)는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CAMPAIGN_NOT_FOUND', message: 'campaign을 찾을 수 없습니다: c9' } } ), { status: 422, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await PATCH(new Request('http://test', { method: 'PATCH' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(422);
  });

  it('PATCH — org mismatch 403도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'org_id mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await PATCH(new Request('http://test', { method: 'PATCH' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(403);
  });
});
