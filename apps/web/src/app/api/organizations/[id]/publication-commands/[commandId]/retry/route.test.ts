import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

describe('/api/organizations/[id]/publication-commands/[commandId]/retry (story #3479)', () => {
  it('POST — FastAPI 공용 재시도 엔드포인트로 id·commandId를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ id: 'cmd-1', command_status: 'pending' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const request = new Request('http://test', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', commandId: 'cmd-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/publication-commands/[commandId]/retry', { id: 'org-1', commandId: 'cmd-1' },
    );
    expect(resp.status).toBe(200);
  });

  it('POST — BE의 !ok 응답(예: 404 COMMAND_NOT_FOUND)을 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'COMMAND_NOT_FOUND' } }), {
        status: 404, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', commandId: 'cmd-1' }) });
    expect(resp.status).toBe(404);
  });
});
