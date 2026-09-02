import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));

vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { PATCH } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/projects/[id]/repeat-schedules/[scheduleId]/resume', () => {
  it('PATCH — FastAPI PATCH resume으로 두 params 모두 위임', async () => {
    const row = { id: 's-1', project_id: 'p-1', definition_key: 'org.x', repeat: 'P7D', next_run_at: '2026-09-09T00:00:00Z', last_run_at: null, status: 'active', pause_reason: null, consecutive_failure_count: 0 };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(row));

    const request = new Request('http://test/api/projects/p-1/repeat-schedules/s-1/resume', { method: 'PATCH' });
    const resp = await PATCH(request, { params: Promise.resolve({ id: 'p-1', scheduleId: 's-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/projects/[id]/repeat-schedules/[scheduleId]/resume', { id: 'p-1', scheduleId: 's-1' },
    );
    await expect(resp.json()).resolves.toEqual({ data: row, error: null, meta: null });
  });

  it('PATCH — 403은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'project owner or org owner/admin required' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await PATCH(new Request('http://test', { method: 'PATCH' }), { params: Promise.resolve({ id: 'p-1', scheduleId: 's-1' }) });
    expect(resp.status).toBe(403);
  });
});
