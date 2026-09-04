import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

describe('/api/organizations/[id]/channel-posts/drafts/[draftId]/assets/confirm (story #3428)', () => {
  it('POST — FastAPI confirm 엔드포인트로 draftId를 그대로 위임, 201 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({
          draft_id: 'd1', version_id: 'v2', version: 2,
          original_width: 4000, original_height: 3000, original_bytes: 12000000,
          final_width: 1440, final_height: 1080, final_bytes: 3100000,
          was_converted: true, image_url: 'https://storage.googleapis.com/bucket/channel-media/o/d1/x.jpg',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request,
      '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/assets/confirm',
      { id: 'org-1', draftId: 'd1' },
    );
    expect(resp.status).toBe(201);
  });

  it('POST — 413(CHANNEL_IMAGE_TOO_LARGE) 같은 !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ detail: { code: 'CHANNEL_IMAGE_TOO_LARGE', size_bytes: 30000000, max_bytes: 26214400 } }),
        { status: 413, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(413);
  });
});
