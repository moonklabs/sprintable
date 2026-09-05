import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET, PUT } from './route';

describe('/api/organizations/[id]/content-rules (story #3472)', () => {
  it('GET — FastAPI 콘텐츠 규칙 조회 엔드포인트로 id를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ org_id: 'org-1', rules: { banned_terms: [] }, version: 1 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', { method: 'GET' });
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/content-rules', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
  });

  it('PUT — FastAPI PUT으로 id·body를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ org_id: 'org-1', rules: { banned_terms: ['금지어'] }, version: 2 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', {
      method: 'PUT',
      body: JSON.stringify({ rules: { banned_terms: ['금지어'] } }),
    });
    const resp = await PUT(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/content-rules', { id: 'org-1' },
    );
    expect(resp.status).toBe(200);
  });

  it('PUT — BE의 CHANNEL_CONNECTION류와 동형인 403 CONTENT_RULES_OWNER_ONLY도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'CONTENT_RULES_OWNER_ONLY' } }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await PUT(new Request('http://test', { method: 'PUT' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });

  it('PUT — BE의 422 CONTENT_RULES_INVALID도 그대로 통과시킨다(삼키지 않음)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'CONTENT_RULES_INVALID' } }), {
        status: 422, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const resp = await PUT(new Request('http://test', { method: 'PUT' }), { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(422);
  });
});
