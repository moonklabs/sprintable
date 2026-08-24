/**
 * story #2909② — 유료→유료 상향(change-tier)·하향 예약(#2881)·취소 예약(#2882)의 FE
 * 진입점. `toss-checkout.ts`(신규 결제·Toss 위젯)와 달리 이 셋은 이미 유효한 billing_key로
 * 즉시 처리되거나(change-tier) 순수 메타데이터 write(downgrade/cancel)라 위젯 리다이렉트가
 * 없다 — 단순 fetch로 완결.
 */
import { fetchWithAuth } from '@/lib/db/client';
import type { TierId } from './pricing-data';

export interface ChangeTierResult {
  org_id: string;
  tier: string;
  billing_cycle: string | null;
  status: string;
  current_period_start: string | null;
  current_period_end: string | null;
  declined_reason: string | null;
  pending_tier: string | null;
  pending_change_apply_at: string | null;
}

export type ChangeTierOutcome =
  | { kind: 'active'; result: ChangeTierResult }
  | { kind: 'declined'; result: ChangeTierResult }
  | { kind: 'error'; status: number };

async function postBillingAction(path: string, body?: object): Promise<ChangeTierOutcome> {
  const res = await fetchWithAuth(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    return { kind: 'error', status: res.status };
  }
  const json = (await res.json()) as { data: ChangeTierResult };
  const result = json.data;
  return result.status === 'active' ? { kind: 'active', result } : { kind: 'declined', result };
}

/** 유료→유료 상향 — 신 offering 전액 즉시 청구(기존 billing_key 재사용, authKey 불요). */
export async function changeTier(newTier: Exclude<TierId, 'free'>): Promise<ChangeTierOutcome> {
  return postBillingAction('/api/billing/change-tier', { new_tier: newTier });
}

/** 하향 예약 — 다음 갱신일부터 적용(즉시 전이 없음, 부분 환불 없음). */
export async function reserveDowngrade(newTier: Exclude<TierId, 'free'>): Promise<ChangeTierOutcome> {
  return postBillingAction('/api/billing/downgrade', { new_tier: newTier });
}

/** 구독 취소 예약 — 현재 기간 말까지 사용, 다음 갱신 중지(=tier=free로의 하향 예약). */
export async function cancelSubscription(): Promise<ChangeTierOutcome> {
  return postBillingAction('/api/billing/cancel');
}

/**
 * 예약 철회(하향·취소 공통) — pending_*만 클리어, 구독 원 tier는 무변화. 하향/취소 어느
 * 쪽이 예약돼 있었든 같은 슬롯이라(#2882가 #2881 슬롯 재사용) 이 한 경로로 충분하다
 * (재구현 0 — BE `cancel_pending_downgrade`가 이미 동형).
 */
export async function revokePendingChange(): Promise<ChangeTierOutcome> {
  const res = await fetchWithAuth('/api/billing/downgrade', { method: 'DELETE', credentials: 'include' });
  if (!res.ok) {
    return { kind: 'error', status: res.status };
  }
  const json = (await res.json()) as { data: ChangeTierResult };
  return { kind: 'active', result: json.data };
}

// story #2989 — 결제수단 조회+셀프서브 삭제. FE가 등록만 하고 지금 뭐가 등록돼 있는지
// 보여줄 표면이 아예 없던 갭(그라운딩 실측) — 이 둘이 그 표면.
export interface BillingKeyInfo {
  org_id: string;
  status: string;
  card_issuer_code: string | null;
  card_number_masked: string | null;
  card_type: string | null;
}

export async function fetchBillingKey(): Promise<BillingKeyInfo | null> {
  const res = await fetchWithAuth('/api/billing/billing-key', { credentials: 'include' });
  if (!res.ok) return null;
  const json = (await res.json()) as { data: BillingKeyInfo | null };
  return json.data;
}

export type DeleteBillingKeyOutcome =
  | { kind: 'deleted' }
  | { kind: 'blocked'; tier: string }
  | { kind: 'error'; status: number };

/** 셀프서브 결제수단 삭제 — Toss 실 폐기 포함(BE revoke_billing_key). 활성 유료 구독이
 * 있으면 서버가 409(active_subscription_blocks_revoke)로 거부한다(P3, 선생님 정책
 * 확定 2026-08-24 — 판별자는 「현재 유효 여부」뿐, 예약된 해지/다운그레이드는 안 봄). */
export async function deleteBillingKey(): Promise<DeleteBillingKeyOutcome> {
  const res = await fetchWithAuth('/api/billing/billing-key', { method: 'DELETE', credentials: 'include' });
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { error?: { tier?: string } } | null;
    return { kind: 'blocked', tier: body?.error?.tier ?? '' };
  }
  if (!res.ok) return { kind: 'error', status: res.status };
  return { kind: 'deleted' };
}
