import { describe, expect, it, vi } from 'vitest';

const { proxyToFastapiWithParams } = vi.hoisted(() => ({ proxyToFastapiWithParams: vi.fn() }));
vi.mock('@/lib/fastapi-proxy', () => ({ proxyToFastapiWithParams }));

import { POST } from './route';

// story #3813(Phase3·3-4 PR5-a) — wordpress/route.test.ts·webhook/route.test.ts와
// 동형(3건: 성공·403 HUMAN_ONLY 통과·422 STIBEE_API_KEY_INVALID 통과) — 검증 로직
// 0인 pass-through BFF라 새 시나리오 발명 없이 선례를 그대로 미러. 이 파일 자체가
// 없어 브라우저에서 「Connect Stibee」를 눌러도 404였던 결함(실측, 형제들과 같은
// 결함 클래스 세 번째 재발)의 회귀 고정.
describe('/api/organizations/[id]/channel-connections/stibee (story #3813 PR5-a)', () => {
  it('POST — FastAPI stibee 연결 생성 엔드포인트로 id·body를 그대로 위임', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'c1', channel: 'stibee', account_id: 'default', status: 'active' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const request = new Request('http://test', {
      method: 'POST',
      body: JSON.stringify({ api_key: 'real-key', list_id: '12345' }),
    });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });

    expect(proxyToFastapiWithParams).toHaveBeenCalledWith(
      request, '/api/v2/organizations/[id]/channel-connections/stibee', { id: 'org-1' },
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

  it('POST — BE의 STIBEE_API_KEY_INVALID 422도 그대로 통과시킨다(auth-check 실패 fail-closed)', async () => {
    proxyToFastapiWithParams.mockResolvedValue(
      new Response(JSON.stringify({ detail: { code: 'STIBEE_API_KEY_INVALID' } }), {
        status: 422, headers: { 'Content-Type': 'application/json' },
      }),
    );
    const request = new Request('http://test', {
      method: 'POST',
      body: JSON.stringify({ api_key: 'fake-key', list_id: '12345' }),
    });
    const resp = await POST(request, { params: Promise.resolve({ id: 'org-1' }) });
    expect(resp.status).toBe(422);
  });
});
