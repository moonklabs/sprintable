// story #3209(PR-1) — 카디르 QA 블로킹(PR#3605): FE 컴포넌트 테스트가 `fetchWithAuth`를
// 모듈째 mock해 이 프록시 경로(route.ts → proxyToFastapiWrapped → apiSuccess) 자체를 안
// 지나가서, BE가 `{"data": [...]}`를 반환하면 최종 응답이 `{data: {data: [...]}}`로
// 이중래핑되는 버그를 못 잡았다. 이 파일은 그 실경로(fastapi-proxy.test.ts와 동형 —
// global.fetch mock으로 BE 응답을 흉내내고 route의 GET을 직접 호출)를 지나며 최종 JSON
// 모양을 고정한다 — "로직 증명"이 아니라 "실경로 도달" 증명.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getServerSessionMock } = vi.hoisted(() => ({
  getServerSessionMock: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ getServerSession: getServerSessionMock }));

import { GET } from './route';

describe('/api/billing/orders — 이중래핑 회귀가드(story #3209, 카디르 QA)', () => {
  beforeEach(() => {
    getServerSessionMock.mockReset();
    getServerSessionMock.mockResolvedValue({ access_token: 'token-1', org_id: 'org-1' });
  });

  it('BE가 flat list를 반환하면 FE 최종 응답은 단일래핑 {data: [...]}이다(이중래핑 금지)', async () => {
    const beOrders = [{
      order_id: 'order-1', created_at: '2026-08-29T10:00:00Z', amount_minor: 49000,
      currency: 'KRW', status: 'confirmed', purpose: 'charge',
      receipt_url: 'https://dashboard.tosspayments.com/receipt/abc123',
    }];
    // BE 라우터(list_billing_orders)가 실제로 반환하는 형상 — flat list(dict로 감싸지 않음).
    global.fetch = vi.fn(async () => new Response(JSON.stringify(beOrders), { status: 200 }));

    const res = await GET(new Request('http://localhost/api/billing/orders'));
    const json = await res.json();

    // 이중래핑이었다면 json.data가 {data: [...]}(object)였을 것 — 배열 자체여야 한다.
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data).toEqual(beOrders);
    expect(json.error).toBeNull();
  });
});
