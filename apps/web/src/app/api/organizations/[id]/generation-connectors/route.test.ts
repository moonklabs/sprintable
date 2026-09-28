import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET, POST } from './route';

function fastapiOk(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('/api/organizations/[id]/generation-connectors (story #4101)', () => {
  it('GET — FastAPI 목록으로 위임, credentials 필드 없이 그대로 통과', async () => {
    const body = {
      connectors: [
        { id: 'gc-1', provider_key: 'vertex_gemini', label: '메인', model_config_json: {}, status: 'active', created_by: null },
      ],
    };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(body));
    const request = new Request('http://test/api/organizations/org-1/generation-connectors?active_only=true');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });
    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(request, '/api/v2/organizations/[id]/generation-connectors', { id: 'org-1' });
    await expect(resp.json()).resolves.toEqual({ data: body, error: null, meta: null });
  });

  it('GET — !ok는 그대로 pass-through(예: 403 휴먼 org 멤버만)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'GENERATION_CONNECTOR_HUMAN_ONLY' } }), { status: 403 }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });

  // story #4101 CHANGES-2(페드루 PO 리뷰, 2026-09-21) — 이 라우트가 없어 dev에서 누구도
  // 첫 연산 커넥터를 등록할 길이 없었다(channel-connections/sandbox/route.ts와 동형 축).
  it('POST — FastAPI 등록 엔드포인트로 id를 그대로 위임(201)', async () => {
    const created = { id: 'gc-1', provider_key: 'vertex_gemini', label: '메인', model_config_json: {}, status: 'active', created_by: 'u1' };
    proxyToFastapiWithParams.mockResolvedValue(fastapiOk(created, 201));
    const request = new Request('http://test', { method: 'POST', body: JSON.stringify({ provider_key: 'vertex_gemini', label: '메인', credentials: 'sk-x' }) });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(request, '/api/v2/organizations/[id]/generation-connectors', { id: 'org-1' });
    expect(resp.status).toBe(201);
    await expect(resp.json()).resolves.toEqual({ data: created, error: null, meta: null });
  });

  it('POST — !ok는 그대로 pass-through(예: 403 owner/admin만 등록 가능)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'GENERATION_CONNECTOR_OWNER_OR_ADMIN_ONLY' } }), { status: 403 }),
    );
    const resp = await POST(new Request('http://test', { method: 'POST' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });
});
