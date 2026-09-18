import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

describe('/api/organizations/[id]/channel-posts/publication-commands/[commandId]/retry (story f061c1a3)', () => {
  it('POST — FastAPI retry 엔드포인트로 commandId를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ id: 'cmd-1', status: 'pending' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const request = new Request('http://test', { method: 'POST' });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', commandId: 'cmd-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-posts/publication-commands/[commandId]/retry', { id: 'org-1', commandId: 'cmd-1' },
    );
    expect(resp.status).toBe(200);
  });

  it('POST — 404(재시도 대상 아님·존재 비노출) 같은 !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'command를 찾을 수 없거나 재시도 대상이 아닙니다' }), { status: 404, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', commandId: 'cmd-1' }) });
    expect(resp.status).toBe(404);
  });

  it('POST — 에이전트 헤더로 온 요청도 BE의 human-only 403을 그대로 통과시킨다(삼키지 않음)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_CONNECTION_HUMAN_ONLY' } }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const request = new Request('http://test', { method: 'POST', headers: { Authorization: 'Bearer agent-key-123' } });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1', commandId: 'cmd-1' }) });
    expect(resp.status).toBe(403);
  });

  it('POST — org mismatch 403도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'org_id mismatch' }), { status: 403, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', commandId: 'cmd-1' }) });
    expect(resp.status).toBe(403);
  });

  it('POST — 무자격 요청에 대한 BE의 401도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(null, { status: 401 }));
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1', commandId: 'cmd-1' }) });
    expect(resp.status).toBe(401);
  });
});
