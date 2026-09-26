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
    const arg = requestBillingAuthMock.mock.calls[0]?.[0] as { method: string; windowTarget: string; successUrl: string; failUrl: string };
    expect(arg.method).toBe('CARD');
    // 라이브 실측(2026-08-07) — SDK 기본값(PC=iframe)이 CSP frame-src 'none'과 충돌해
    // 실제로 막혔다. 'self' 고정으로 frame-src를 열지 않고 우회.
    expect(arg.windowTarget).toBe('self');
    // billing_cycle API 값은 yearly(FE 내부 표기) -> annual(BE 계약, #2890)로 변환돼야 한다.
    // story #4335 — 결제 시도 id(UUID)를 위젯 가기 전에 만들어 복귀 URL 둘 다에 같은 값으로 싣는다.
    const success = new URL(arg.successUrl);
    const attemptId = success.searchParams.get('attempt') ?? '';
    expect(attemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(arg.successUrl).toBe(`${ORIGIN}/settings?tab=billing&tier=starter&cycle=annual&attempt=${attemptId}&checkout=success`);
    expect(arg.failUrl).toBe(`${ORIGIN}/settings?tab=billing&tier=starter&cycle=annual&attempt=${attemptId}&checkout=fail`);
  });

  it('위젯을 열 때마다 새 시도 id(두 번 열면 서로 다름)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { customer_key: 'org-abc-123' } }) })));
    await startBillingAuth({ tier: 'team', cycle: 'monthly' });
    await startBillingAuth({ tier: 'team', cycle: 'monthly' });
    const ids = requestBillingAuthMock.mock.calls.map((c) => new URL((c[0] as { successUrl: string }).successUrl).searchParams.get('attempt'));
    expect(new Set(ids).size).toBe(2);
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

describe('completeCheckout — 결제 시도 시작(story #2510 · #4335)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ATTEMPT = { attempt_id: 'a-1', kind: 'checkout', status: 'processing', tier: 'team', billing_cycle: 'monthly', declined_reason: null, reauth_required: false, subscription: null };

  it('/api/billing/checkout에 {attempt_id, auth_key, tier, billing_cycle}를 POST하고 시도 상태를 돌려준다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202, json: async () => ({ data: ATTEMPT }) }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await completeCheckout({ attemptId: 'a-1', authKey: 'ak-xyz', tier: 'business', billingCycle: 'annual' });

    expect(result).toEqual({ kind: 'ok', attempt: ATTEMPT });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/billing/checkout',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ attempt_id: 'a-1', auth_key: 'ak-xyz', tier: 'business', billing_cycle: 'annual' }),
      }),
    );
  });

  it('확실한 거절 4xx(400 · 403 · 422) → {kind:"rejected", status} — 시도가 만들어지지 않음', async () => {
    for (const status of [400, 403, 422]) {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, json: async () => ({}) })));
      expect(await completeCheckout({ attemptId: 'a-1', authKey: 'ak', tier: 'team', billingCycle: 'monthly' })).toEqual({ kind: 'rejected', status });
    }
  });

  it('⭐409 · 5xx(BFF 503 포함)는 등록됐는지 모름 → {kind:"unreached"} — «청구 없음»이 아니라 조회로(까디르 ②)', async () => {
    for (const status of [409, 500, 502, 503]) {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status, json: async () => ({}) })));
      expect(await completeCheckout({ attemptId: 'a-1', authKey: 'ak', tier: 'team', billingCycle: 'monthly' }), String(status)).toEqual({ kind: 'unreached' });
    }
  });

  it('네트워크 · 시간 초과 → {kind:"unreached"} — 화면은 재요청이 아니라 조회로 넘어간다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await completeCheckout({ attemptId: 'a-1', authKey: 'ak', tier: 'team', billingCycle: 'monthly' })).toEqual({ kind: 'unreached' });
  });
});
