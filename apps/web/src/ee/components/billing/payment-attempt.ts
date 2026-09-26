/**
 * story #4335 — 결제 시도(checkout · change-tier) 클라이언트. 서버는 시도를 만들고 곧바로 돌려주고, 결과는
 * `GET /api/billing/attempts/{id}`로 확정한다 — 끊김 · 시간 초과 · 새로고침 · 재진입 뒤엔 **재요청이 아니라 조회**.
 *
 * 시도 id는 브라우저가 만든다(멱등 키): checkout은 카드 인증(위젯) 가기 전에 만들어 복귀 URL에 싣고, change-tier는 누르는
 * 순간 만든다. 같은 id로 서버에 다시 가도 새 결제가 생기지 않는다.
 */
import { LONG_ROUTES } from '@/lib/bff-route-timeouts';
import { fetchWithAuth } from '@/lib/db/client';

export type PaymentAttemptKind = 'checkout' | 'change_tier';
export type PaymentAttemptStatus = 'processing' | 'succeeded' | 'declined' | 'failed' | 'voided';
/** 환불 상태 — voided(청구됐지만 적용 못 해 전액 환불)에서 쓴다. `confirmed`만 «환불했어요», `failed`만 «환불 못 함». */
export type PaymentAttemptRefundStatus = 'pending' | 'confirmed' | 'failed';

export interface PaymentAttemptSubscription {
  org_id: string;
  tier: string;
  billing_cycle: string | null;
  status: string;
}

export interface PaymentAttempt {
  attempt_id: string;
  kind: PaymentAttemptKind;
  status: PaymentAttemptStatus;
  tier: string;
  billing_cycle: string | null;
  declined_reason: string | null;
  reauth_required: boolean;
  refund_status?: PaymentAttemptRefundStatus | null;
  subscription: PaymentAttemptSubscription | null;
}

/** 서버 응답 결과 — `unreached`는 결과를 모르는 응답(네트워크 · 시간 초과 · 404 밖 non-OK 전부)이라 조회로 넘어간다. */
export type AttemptResult =
  | { kind: 'ok'; attempt: PaymentAttempt }
  | { kind: 'notFound' }
  | { kind: 'unreached' };

export function newAttemptId(): string {
  return crypto.randomUUID();
}

async function readAttempt(res: Response): Promise<AttemptResult> {
  if (res.status === 404) return { kind: 'notFound' };
  // PO 04:08Z «결과 모름 = 비종결» — 404 밖 non-OK(400 · 401 · 408 · 409 · 429 · 5xx 전부)는 «거절 · 청구 0»이 아니라 조회로 넘긴다.
  // «청구 0» 안심 문구는 서버가 확정한 결과(Toss 거절 declined · 청구 0이 증명된 failed)나 조회가 «시도 없음(404)»일 때만.
  if (!res.ok) return { kind: 'unreached' };
  const json = (await res.json()) as { data: PaymentAttempt };
  return { kind: 'ok', attempt: json.data };
}

const START_TIMEOUT_MS = {
  '/api/billing/checkout': LONG_ROUTES.billingCheckout.browserMs,
  '/api/billing/change-tier': LONG_ROUTES.billingChangeTier.browserMs,
} as const;

export async function postAttempt(path: keyof typeof START_TIMEOUT_MS, body: object): Promise<AttemptResult> {
  try {
    const res = await fetchWithAuth(path, {
      timeoutMs: START_TIMEOUT_MS[path],
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await readAttempt(res);
  } catch {
    return { kind: 'unreached' };
  }
}

export async function fetchAttempt(attemptId: string): Promise<AttemptResult> {
  try {
    const res = await fetchWithAuth(`/api/billing/attempts/${encodeURIComponent(attemptId)}`, {
      timeoutMs: LONG_ROUTES.billingAttemptStatus.browserMs,
      credentials: 'include',
    });
    return await readAttempt(res);
  } catch {
    return { kind: 'unreached' };
  }
}

// 재진입(파라미터 없이 결제 화면으로 다시 옴)에도 같은 시도를 보여주려고 진행 중 시도 id를 기억한다 — 결과를 보여준 뒤 지운다.
// 저장이 막힌 브라우저(시크릿 창 등)에선 조용히 건너뛴다(URL의 attempt 파라미터가 새로고침은 덮는다).
const STORAGE_KEY = 'sprintable.billing.paymentAttempt';

export interface RememberedAttempt {
  id: string;
  kind: PaymentAttemptKind;
}

export function rememberAttempt(value: RememberedAttempt): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* 저장 불가 — URL 파라미터로만 이어진다 */
  }
}

export function recallAttempt(): RememberedAttempt | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedAttempt>;
    return typeof parsed.id === 'string' && (parsed.kind === 'checkout' || parsed.kind === 'change_tier')
      ? { id: parsed.id, kind: parsed.kind }
      : null;
  } catch {
    return null;
  }
}

export function forgetAttempt(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 저장 불가 — 지울 것도 없다 */
  }
}
