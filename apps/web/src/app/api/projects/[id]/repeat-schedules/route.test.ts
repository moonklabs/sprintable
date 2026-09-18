import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/projects/[id]/repeat-schedules', () => {
  it('GET — FastAPI GET /api/v2/projects/[id]/repeat-schedules로 위임하고 { data } 봉투로 래핑', async () => {
    const list = [{ id: 's-1', project_id: 'p-1', definition_key: 'org.x', repeat: 'P7D', next_run_at: '2026-09-09T00:00:00Z', last_run_at: null, status: 'active', pause_reason: null, consecutive_failure_count: 0 }];
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(list));

    const request = new Request('http://test/api/projects/p-1/repeat-schedules');
    const resp = await GET(request, { params: Promise.resolve({ id: 'p-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(request, '/api/v2/projects/[id]/repeat-schedules', { id: 'p-1' });
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toEqual({ data: list, error: null, meta: null });
  });

  it('GET — 403(project owner/org admin 아님)은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'project owner or org owner/admin required' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'p-1' }) });
    expect(resp.status).toBe(403);
  });
});
