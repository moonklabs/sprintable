import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

describe('/api/organizations/[id]/campaigns/[campaignId] (story 1db41045)', () => {
  it('GET — FastAPI GET /api/v2/organizations/[id]/campaigns/[campaignId]로 위임', async () => {
    const detail = {
      id: 'c1', name: '9월 캠페인', starts_at: null, ends_at: null, status: 'active',
      created_by_member_id: 'm1', created_at: '2026-09-04T00:00:00+00:00',
      content_items: [],
    };
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify(detail), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const request = new Request('http://test');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', campaignId: 'c1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/campaigns/[campaignId]', { id: 'org-1', campaignId: 'c1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: detail, error: null, meta: null });
  });

  it('GET — 존재하지 않는 campaign(404)은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'campaign을 찾을 수 없습니다: c1' }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', campaignId: 'c1' }) });
    expect(resp.status).toBe(404);
  });

  it('GET — org mismatch 403도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'org_id mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', campaignId: 'c1' }) });
    expect(resp.status).toBe(403);
  });
});
