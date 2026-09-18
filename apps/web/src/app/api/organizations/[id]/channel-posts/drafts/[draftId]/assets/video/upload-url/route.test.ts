import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

describe('/api/organizations/[id]/channel-posts/drafts/[draftId]/assets/video/upload-url (story #3556)', () => {
  it('POST — FastAPI video upload-url 엔드포인트로 draftId를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ upload_url: 'https://gcs/put', object_path: 'channel-media/o/d/x.mp4', expires_at: '2026-09-06T12:10:00Z', max_bytes: 104857600, required_put_headers: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request,
      '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/assets/video/upload-url',
      { id: 'org-1', draftId: 'd1' },
    );
    expect(resp.status).toBe(200);
  });

  it('POST — 422(CHANNEL_VIDEO_UNSUPPORTED) 같은 !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ detail: { code: 'CHANNEL_VIDEO_UNSUPPORTED', message: '이 채널은 영상을 지원하지 않습니다', channel: 'threads' } }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(422);
  });
});
