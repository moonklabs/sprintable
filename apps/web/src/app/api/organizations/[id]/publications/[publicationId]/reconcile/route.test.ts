import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

function fastapiResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/publications/[publicationId]/reconcile (story #3620)', () => {
  it('POST — FastAPI POST .../reconcile로 위임하고 201을 그대로 유지', async () => {
    const result = {
      id: 'recon-1', publication_id: 'pub-1', snapshot_id: 'snap-1',
      live_raw: { views: 100 }, verdicts: { views: 'match' }, has_mismatch: false,
      created_at: '2026-09-07T00:00:00Z',
    };
    proxyToFastapiWithParams.mockResolvedValue(fastapiResponse(result, 201));

    const request = new Request('http://test/api/organizations/org-1/publications/pub-1/reconcile', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/publications/[publicationId]/reconcile', { id: 'org-1', publicationId: 'pub-1' },
    );
    expect(resp.status).toBe(201);
    await expect(resp.json()).resolves.toEqual({ data: result, error: null, meta: null });
  });

  it('POST — 409(연결 비활성/채널 미지원)도 그대로 pass-through(정의 2)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'CHANNEL_CONNECTION_NOT_ACTIVE', message: '연결이 활성 상태가 아닙니다' } }, 409),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', publicationId: 'pub-1' }),
    });
    expect(resp.status).toBe(409);
  });

  it('POST — 404 publication 없음도 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      fastapiResponse({ detail: { code: 'INSIGHT_PUBLICATION_NOT_FOUND', message: 'channel_publication을 찾을 수 없습니다' } }, 409),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), {
      params: Promise.resolve({ id: 'org-1', publicationId: 'pub-404' }),
    });
    expect(resp.status).toBe(409);
  });
});
