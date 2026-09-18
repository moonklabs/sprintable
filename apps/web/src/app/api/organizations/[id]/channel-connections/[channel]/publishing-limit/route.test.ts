import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { GET } from './route';

describe('/api/organizations/[id]/channel-connections/[channel]/publishing-limit (story #3402)', () => {
  it('GET — connectionId로 위임(폴더명은 channel이지만 실제 connection_id, 기존 test/route.ts와 동형)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ quota_usage: 3, quota_total: 250, quota_duration_seconds: 86400 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const request = new Request('http://test');
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', channel: 'conn-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/[connectionId]/publishing-limit',
      { id: 'org-1', connectionId: 'conn-1' },
    );
    expect(resp.status).toBe(200);
  });

  it('GET — 409(CHANNEL_TOKEN_EXPIRED) 같은 !ok 응답은 그대로 pass-through', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_TOKEN_EXPIRED' } }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
    );
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', channel: 'conn-1' }) });
    expect(resp.status).toBe(409);
  });

  // 카디르 QA(2026-09-04)·페드루 PO 방향 정정 — 경계는 BE다(get_channel_publishing_limit
  // 이 이미 _require_human()으로 에이전트를 403 fail-closed). BFF에 별도 세션전용 가드를
  // 새로 세우지 않는다(fastapi-proxy.ts::resolveAuthHeader가 플랫폼 전체에서 세션/에이전트
  // 자격을 동등하게 다루는 얇은 프록시라 이 라우트만 다르게 만들면 어긋난다). BE가 낸
  // 403/401을 이 라우트가 삼키지 않고 그대로 통과시키는지만 pin한다.
  it('GET — 에이전트 헤더로 온 요청도 BE의 _require_human 403을 그대로 통과시킨다(삼키지 않음)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(JSON.stringify({ detail: 'human only' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
    const request = new Request('http://test', { headers: { Authorization: 'Bearer agent-key-123' } });
    const resp = await GET(request, { params: Promise.resolve({ id: 'org-1', channel: 'conn-1' }) });
    expect(resp.status).toBe(403);
  });

  it('GET — 무자격 요청에 대한 BE의 401도 그대로 통과시킨다', async () => {
    proxyToFastapiWithParams.mockResolvedValue(new Response(null, { status: 401 }));
    const resp = await GET(new Request('http://test'), { params: Promise.resolve({ id: 'org-1', channel: 'conn-1' }) });
    expect(resp.status).toBe(401);
  });
});
