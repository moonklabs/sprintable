import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

// story e4fc29fa(조각⑤) — sandbox/route.test.ts·wordpress/route.test.ts와 동형(3건:
// 성공·403 HUMAN_ONLY 통과·422 DESTINATION_INSECURE 통과) — 검증 로직 0인
// pass-through BFF라 새 시나리오 발명 없이 선례를 그대로 미러.
describe('/api/organizations/[id]/channel-connections/webhook (story e4fc29fa 조각⑤)', () => {
  it('POST — FastAPI webhook 연결 생성 엔드포인트로 id·body를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'c1', channel: 'webhook', account_id: 'https://hook.example.com/in', status: 'active' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', {
      method: 'POST',
      body: JSON.stringify({ target_url: 'https://hook.example.com/in', secret: 'shh' }),
    });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/webhook', { id: 'org-1' },
    );
    expect(resp.status).toBe(201);
  });

  it('POST — 에이전트 헤더로 온 요청도 BE의 CHANNEL_CONNECTION_HUMAN_ONLY 403을 그대로 통과시킨다(삼키지 않음)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_CONNECTION_HUMAN_ONLY' } }), {
        status: 403, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const request = new Request('http://test', { method: 'POST', headers: { Authorization: 'Bearer agent-key-123' } });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(403);
  });

  it('POST — BE의 CHANNEL_CONNECTION_DESTINATION_INSECURE 422도 그대로 통과시킨다(SSRF 목적지 거부)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'CHANNEL_CONNECTION_DESTINATION_INSECURE' } }), {
        status: 422, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const request = new Request('http://test', {
      method: 'POST',
      body: JSON.stringify({ target_url: 'http://localhost:1337', secret: 'shh' }),
    });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(422);
  });
});
