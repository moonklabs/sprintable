import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

describe('/api/organizations/[id]/channel-posts/drafts/[draftId]/versions (story #3402)', () => {
  it('GET — FastAPI versions 엔드포인트로 draftId를 그대로 위임', async () => {
    const versions = [{ version: 1, text: 'hello', tagged_link_preview: null }];
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify(versions), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const request = new Request('http://test');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', draftId: 'd1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-posts/drafts/[draftId]/versions', { id: 'org-1', draftId: 'd1' },
    );
    await expect(resp.json()).resolves.toEqual({ data: versions, error: null, meta: null });
  });
});
