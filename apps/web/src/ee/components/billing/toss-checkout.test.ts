// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestBillingAuthMock = vi.fn().mockResolvedValue(undefined);
const paymentMock = vi.fn(() => ({ requestBillingAuth: requestBillingAuthMock }));
const loadTossPaymentsMock = vi.fn().mockResolvedValue({ payment: paymentMock });

vi.mock('@tosspayments/tosspayments-sdk', () => ({
  loadTossPayments: (...args: unknown[]) => loadTossPaymentsMock(...args),
}));

import { completeCheckout, startBillingAuth } from './toss-checkout';

const ORIGIN = 'https://app.sprintable.example';

function stubLocation() {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { origin: ORIGIN },
  });
}

describe('startBillingAuth — 위젯 인증 시작(story #2510)', () => {
  beforeEach(() => {
    stubLocation();
    requestBillingAuthMock.mockClear();
    paymentMock.mockClear();
    loadTossPaymentsMock.mockClear();
    vi.stubEnv('NEXT_PUBLIC_TOSS_CLIENT_KEY', 'test_ck_dummy');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('서버 customerKey를 조회해 payment({customerKey})로 위젯을 연다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: { customer_key: 'org-abc-123' } }) }));
    vi.stubGlobal('fetch', fetchMock);

    await startBillingAuth({ tier: 'team', cycle: 'monthly' });

    expect(paymentMock).toHaveBeenCalledWith({ customerKey: 'org-abc-123' });
    // 계약 확定(#2512) — customer-key는 POST(바디 없음)로 발급/조회한다. GET 회귀 방지.
    expect(fetchMock).toHaveBeenCalledWith('/api/billing/customer-key', expect.objectContaining({ method: 'POST' }));
  });

  it('requestBillingAuth에 method=CARD·successUrl/failUrl(tier·cycle 보존)을 정확히 싣는다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ data: { customer_key: 'org-abc-123' } }) })),
    );

    await startBillingAuth({ tier: 'starter', cycle: 'yearly' });

    expect(requestBillingAuthMock).toHaveBeenCalledTimes(1);
    const arg = requestBillingAuthMock.mock.calls[0]?.[0] as { method: string; successUrl: string; failUrl: string };
    expect(arg.method).toBe('CARD');
    // billing_cycle API 값은 yearly(FE 내부 표기) -> annual(BE 계약, #2890)로 변환돼야 한다.
    expect(arg.successUrl).toBe(`${ORIGIN}/settings?tab=billing&tier=starter&cycle=annual&checkout=success`);
    expect(arg.failUrl).toBe(`${ORIGIN}/settings?tab=billing&tier=starter&cycle=annual&checkout=fail`);
  });

  it('customer-key 응답이 실패(non-ok)면 위젯을 열지 않고 던진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    await expect(startBillingAuth({ tier: 'team', cycle: 'monthly' })).rejects.toThrow();
    expect(loadTossPaymentsMock).not.toHaveBeenCalled();
  });

  it('customer-key 응답에 customer_key 필드가 없으면 던진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })));

    await expect(startBillingAuth({ tier: 'team', cycle: 'monthly' })).rejects.toThrow();
  });

  it('NEXT_PUBLIC_TOSS_CLIENT_KEY 미설정이면 customer-key도 조회하지 않고 즉시 던진다', async () => {
    vi.stubEnv('NEXT_PUBLIC_TOSS_CLIENT_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(startBillingAuth({ tier: 'team', cycle: 'monthly' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('completeCheckout — authKey로 실 체크아웃 완결(story #2510)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('status=active 응답 → {kind:"active"}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { org_id: 'o1', tier: 'team', billing_cycle: 'monthly', status: 'active', current_period_start: null, current_period_end: null, declined_reason: null } }),
      })),
    );

    const outcome = await completeCheckout({ authKey: 'ak', tier: 'team', billingCycle: 'monthly' });
    expect(outcome.kind).toBe('active');
  });

  it('status=pending(카드거절) 응답 → {kind:"declined"} — 에러로 취급하지 않는다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { org_id: 'o1', tier: 'team', billing_cycle: 'monthly', status: 'pending', current_period_start: null, current_period_end: null, declined_reason: '카드 한도 초과' } }),
      })),
    );

    const outcome = await completeCheckout({ authKey: 'ak', tier: 'team', billingCycle: 'monthly' });
    expect(outcome.kind).toBe('declined');
    if (outcome.kind === 'declined') {
      expect(outcome.result.declined_reason).toBe('카드 한도 초과');
    }
  });

  it('HTTP 에러(예: 403/502) → {kind:"error", status}', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })));

    const outcome = await completeCheckout({ authKey: 'ak', tier: 'team', billingCycle: 'monthly' });
    expect(outcome).toEqual({ kind: 'error', status: 502 });
  });

  it('/api/billing/checkout에 {auth_key, tier, billing_cycle} 그대로 POST한다', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { org_id: 'o1', tier: 'business', billing_cycle: 'annual', status: 'active', current_period_start: null, current_period_end: null, declined_reason: null } }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await completeCheckout({ authKey: 'ak-xyz', tier: 'business', billingCycle: 'annual' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/billing/checkout',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ auth_key: 'ak-xyz', tier: 'business', billing_cycle: 'annual' }),
      }),
    );
  });
});
