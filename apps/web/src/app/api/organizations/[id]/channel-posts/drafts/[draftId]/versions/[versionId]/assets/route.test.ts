import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

describe('/api/organizations/[id]/channel-posts/drafts/[draftId]/versions/[versionId]/assets (story #3550)', () => {
  it('GET — FastAPI 목록 엔드포인트로 id/draftId/versionId 그대로 위임, position 순 배열 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify([
          { image_id: 'i1', draft_id: 'd1', version_id: 'v2', version: 2, position: 0, was_converted: false, image_url: 'https://x/1.jpg', original_width: 1000, original_height: 1000, original_bytes: 100, final_width: 1000, final_height: 1000, final_bytes: 100 },
          { image_id: 'i2', draft_id: 'd1', version_id: 'v2', version: 2, position: 1, was_converted: true, image_url: 'https://x/2.jpg', original_width: 4000, original_height: 3000, original_bytes: 5000000, final_width: 1440, final_height: 1080, final_bytes: 900000 },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1', versionId: 'v2' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request,
      '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/versions/[versionId]/assets',
      { id: 'org-1', draftId: 'd1', versionId: 'v2' },
    );
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ data: [{ image_id: 'i1' }, { image_id: 'i2' }] });
  });

  it('GET — 404(CHANNEL_POST_VERSION_NOT_FOUND) 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_POST_VERSION_NOT_FOUND' } }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', draftId: 'd1', versionId: 'v-missing' }) });
    expect(resp.status).toBe(404);
  });
});
