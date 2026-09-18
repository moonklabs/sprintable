import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

describe('/api/organizations/[id]/channel-posts/drafts/[draftId]/assets/upload-url (story #3428)', () => {
  it('POST — FastAPI upload-url 엔드포인트로 draftId를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ upload_url: 'https://gcs/put', object_path: 'channel-media/o/d/x.jpg', expires_at: '2026-09-04T12:10:00Z', max_bytes: 26214400, required_put_headers: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request,
      '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/assets/upload-url',
      { id: 'org-1', draftId: 'd1' },
    );
    expect(resp.status).toBe(200);
  });

  it('POST — 422(CHANNEL_IMAGE_UNSUPPORTED_FORMAT) 같은 !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ detail: { code: 'CHANNEL_IMAGE_UNSUPPORTED_FORMAT', content_type: 'image/gif', allowed_formats: ['image/jpeg', 'image/png'] } }),
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });
    expect(resp.status).toBe(422);
  });
});
