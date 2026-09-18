import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { DELETE } from './route';

describe('/api/organizations/[id]/channel-posts/drafts/[draftId]/assets/[imageId] (story #3550)', () => {
  it('DELETE — FastAPI 삭제 엔드포인트로 id/draftId/imageId 그대로 위임, 남은 목록 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify([
          { image_id: 'i1', draft_id: 'd1', version_id: 'v3', version: 3, position: 0, was_converted: false, image_url: 'https://x/1.jpg', original_width: 1000, original_height: 1000, original_bytes: 100, final_width: 1000, final_height: 1000, final_bytes: 100 },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', { method: 'DELETE' });
    const resp = await DELETE(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1', imageId: 'i2' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request,
      '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/assets/[imageId]',
      { id: 'org-1', draftId: 'd1', imageId: 'i2' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ data: [{ image_id: 'i1' }] });
  });

  it('DELETE — 404(CHANNEL_POST_IMAGE_NOT_FOUND) 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_POST_IMAGE_NOT_FOUND' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await DELETE(new Request('http://test', { method: 'DELETE' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1', imageId: 'i-missing' }) });
    expect(resp.status).toBe(404);
  });
});
