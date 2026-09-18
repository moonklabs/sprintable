import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

describe('/api/organizations/[id]/channel-posts/drafts/[draftId]/assets/video/confirm (story #3556)', () => {
  it('POST — FastAPI video confirm 엔드포인트로 draftId를 그대로 위임, 201 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({
          video_id: 'vid1', draft_id: 'd1', version_id: 'v2', version: 2,
          duration_seconds: 12.5, width: 1080, height: 1920, codec: 'avc1',
          original_bytes: 20000000, video_url: 'https://storage.googleapis.com/bucket/channel-media/o/d1/x.mp4',
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request,
      '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/assets/video/confirm',
      { id: 'org-1', draftId: 'd1' },
    );
    expect(resp.status).toBe(201);
  });

  it('POST — 422(CHANNEL_VIDEO_DURATION_EXCEEDED) 같은 !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ detail: { code: 'CHANNEL_VIDEO_DURATION_EXCEEDED', message: '90초를 넘습니다', max_seconds: 90 } }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(422);
  });
});
