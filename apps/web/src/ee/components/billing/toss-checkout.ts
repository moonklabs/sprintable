/**
 * 결제②-D(story #2510) — Toss 결제위젯 빌링(자동결제) 인증 SDK 배선.
 *
 * Toss v2 SDK 타입정의(npm 패키지 실물 대조, 2026-08-07) 기준 — `requestBillingAuth`는
 * successUrl/failUrl로 브라우저를 이동시키는 리다이렉트 플로우다(모달 인라인 완결 아님).
 * successUrl 복귀 시 쿼리파라미터로 `authKey`·`customerKey`가 실려 온다.
 *
 * customerKey는 FE가 생성하지 않는다 — C1 규율(서버가 조직별 추측 불가능한 customerKey를
 * 발급·org에 매핑)을 그대로 따른다. 계약 확定(#2512, PR #2890/#2892, 2026-08-07) —
 * `POST /api/v2/org-billing-keys/customer-key`(바디 없음) → `{customer_key}`, 멱등(org당
 * 몇 번 불러도 같은 값 — 위젯 인증 前 「awaiting_auth」 placeholder 발급, 인증 完 後
 * checkout이 같은 값을 재사용해 실 빌링키로 덮어씀).
 */
import { loadTossPayments } from '@tosspayments/tosspayments-sdk';
import type { TierId } from './pricing-data';

const CUSTOMER_KEY_PATH = '/api/billing/customer-key';

export interface BillingCycleParam {
  tier: Exclude<TierId, 'free'>;
  cycle: 'monthly' | 'yearly';
}

function toBillingCycleApiValue(cycle: 'monthly' | 'yearly'): 'monthly' | 'annual' {
  return cycle === 'yearly' ? 'annual' : 'monthly';
}

async function fetchCustomerKey(): Promise<string> {
  const res = await fetch(CUSTOMER_KEY_PATH, { method: 'POST', credentials: 'include' });
  if (!res.ok) {
    throw new Error(`customer-key fetch failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { data?: { customer_key?: string } };
  const customerKey = json.data?.customer_key;
  if (!customerKey) {
    throw new Error('customer-key response missing customer_key');
  }
  return customerKey;
}

/**
 * Toss 위젯 카드 등록창을 연다 — 성공/실패 모두 브라우저 리다이렉트로 귀결되므로
 * 이 함수는 정상 흐름에서 반환하지 않는다(페이지 이탈).
 */
export async function startBillingAuth({ tier, cycle }: BillingCycleParam): Promise<void> {
  const clientKey = process.env['NEXT_PUBLIC_TOSS_CLIENT_KEY'];
  if (!clientKey) {
    throw new Error('NEXT_PUBLIC_TOSS_CLIENT_KEY not configured');
  }

  const customerKey = await fetchCustomerKey();
  const tossPayments = await loadTossPayments(clientKey);
  const payment = tossPayments.payment({ customerKey });

  const returnParams = new URLSearchParams({ tab: 'billing', tier, cycle: toBillingCycleApiValue(cycle) });
  const origin = window.location.origin;

  await payment.requestBillingAuth({
    method: 'CARD',
    // windowTarget 명시 — SDK 기본값(PC=iframe)은 CSP frame-src 'none'과 충돌한다(라이브
    // 실측 확認). 'self'로 고정해 데스크톱/모바일 모두 전체페이지 리다이렉트로 통일 —
    // frame-src를 열지 않고도 동작(더 좁은 CSP 변경, script-src/connect-src만 확장).
    windowTarget: 'self',
    successUrl: `${origin}/settings?${returnParams.toString()}&checkout=success`,
    failUrl: `${origin}/settings?${returnParams.toString()}&checkout=fail`,
  });
}

export interface CheckoutResult {
  org_id: string;
  tier: string;
  billing_cycle: string | null;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  declined_reason: string | null;
}

export type CheckoutOutcome =
  | { kind: 'active'; result: CheckoutResult }
  | { kind: 'declined'; result: CheckoutResult }
  | { kind: 'error'; status: number };

/** successUrl 복귀 後 authKey로 실 체크아웃(구독 성립 + 즉시 1차 청구)을 완결한다. */
export async function completeCheckout(params: {
  authKey: string;
  tier: Exclude<TierId, 'free'>;
  billingCycle: 'monthly' | 'annual';
}): Promise<CheckoutOutcome> {
  const res = await fetch('/api/billing/checkout', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_key: params.authKey, tier: params.tier, billing_cycle: params.billingCycle }),
  });

  if (!res.ok) {
    return { kind: 'error', status: res.status };
  }
  const json = (await res.json()) as { data: CheckoutResult };
  const result = json.data;
  return result.status === 'active' ? { kind: 'active', result } : { kind: 'declined', result };
}
