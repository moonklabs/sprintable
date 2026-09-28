import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';

describe('/api/organizations/[id]/background-jobs/[jobId] (story #4336 PR2)', () => {
  it('GET — 백엔드 작업 상태 보기로 위임 · {data: 작업}으로 감싼다 · 시한은 표 한 곳', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(
      JSON.stringify({ id: 'j1', kind: 'channel_video_confirm', status: 'pending', result: null, error: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const request = new Request('http://test');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', jobId: 'j1' }) });
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/background-jobs/[jobId]', { id: 'org-1', jobId: 'j1' },
      expect.objectContaining({ timeoutMs: LONG_ROUTES.backgroundJobStatus.bffMs }),
    );
    expect(resp.status).toBe(200);
    expect((await resp.json()).data.status).toBe('pending');
  });

  it('GET — 404(다른 사람 · 다른 조직)는 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(
      JSON.stringify({ detail: { code: 'BACKGROUND_JOB_NOT_FOUND' } }), { status: 404, headers: { 'Content-Type': 'application/json' } },
    ));
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', jobId: 'j1' }) });
    expect(resp.status).toBe(404);
  });
});
