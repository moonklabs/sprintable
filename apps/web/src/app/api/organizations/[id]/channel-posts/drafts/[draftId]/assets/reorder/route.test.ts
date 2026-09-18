import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

describe('/api/organizations/[id]/channel-posts/drafts/[draftId]/assets/reorder (story #3550)', () => {
  it('POST — FastAPI reorder 엔드포인트로 id/draftId 그대로 위임, 새 순서 목록 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify([
          { image_id: 'i2', draft_id: 'd1', version_id: 'v3', version: 3, position: 0, was_converted: false, image_url: 'https://x/2.jpg', original_width: 1000, original_height: 1000, original_bytes: 100, final_width: 1000, final_height: 1000, final_bytes: 100 },
          { image_id: 'i1', draft_id: 'd1', version_id: 'v3', version: 3, position: 1, was_converted: false, image_url: 'https://x/1.jpg', original_width: 1000, original_height: 1000, original_bytes: 100, final_width: 1000, final_height: 1000, final_bytes: 100 },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', { method: 'POST', body: JSON.stringify({ image_ids: ['i2', 'i1'] }) });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request,
      '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/assets/reorder',
      { id: 'org-1', draftId: 'd1' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ data: [{ image_id: 'i2', position: 0 }, { image_id: 'i1', position: 1 }] });
  });

  it('POST — 422(CHANNEL_POST_IMAGE_REORDER_INVALID_SET) 부분집합 요청은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_POST_IMAGE_REORDER_INVALID_SET' } }), { status: 422, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await POST(
      new Request('http://test', { method: 'POST', body: JSON.stringify({ image_ids: ['i1'] }) }),
      { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) },
    );
    expect(resp.status).toBe(422);
  });
});
