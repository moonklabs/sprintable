/**
 * v2.3 결제 정책 seed 값 — pricing-policy-v2-3 doc 기준.
 * ⛔대표 승인 前 확정가 아님. `isPricePublic=false`인 동안 이 값은 화면에 렌더되지 않는다
 * (billing-tab.tsx의 상태 A 분기가 가격 자리를 플레이스홀더로 대체).
 * offering_versions BE(#2474) 연동 후 이 상수는 API 응답으로 대체된다.
 */

export type TierId = 'free' | 'starter' | 'team' | 'business';

export interface TierLimits {
  seats: number;
  seatAddOnPriceKrw: number | null;
  /** null = 무제한 */
  agents: number | null;
  /** D15: 화면엔 이 배수만 노출 — automationUnits(AU 원수)는 화면 미노출 */
  automationMultiplier: number;
  automationUnits: number;
  realtimeConnections: number;
  storageGb: number;
  maxFileMb: number;
  requestsPerMin: number;
  automationRules: number;
  webhooks: number;
  eventReplayDays: number;
  /** D14: Free는 포함량 도달 시 멈춤(팩 불가) — Starter+는 팩으로 계속 */
  canPurchasePacks: boolean;
}

export interface TierDefinition {
  id: TierId;
  priceMonthlyKrw: number;
  limits: TierLimits;
}

export const TIER_ORDER: readonly TierId[] = ['free', 'starter', 'team', 'business'];

export const TIER_DEFINITIONS: Record<TierId, TierDefinition> = {
  free: {
    id: 'free',
    priceMonthlyKrw: 0,
    limits: {
      seats: 3,
      seatAddOnPriceKrw: null,
      agents: 3,
      automationMultiplier: 1,
      automationUnits: 50_000,
      realtimeConnections: 10,
      storageGb: 5,
      maxFileMb: 100,
      requestsPerMin: 120,
      automationRules: 3,
      webhooks: 0,
      eventReplayDays: 7,
      canPurchasePacks: false,
    },
  },
  starter: {
    id: 'starter',
    priceMonthlyKrw: 29_000,
    limits: {
      seats: 3,
      seatAddOnPriceKrw: null,
      agents: null,
      automationMultiplier: 3,
      automationUnits: 150_000,
      realtimeConnections: 12,
      storageGb: 10,
      maxFileMb: 300,
      requestsPerMin: 300,
      automationRules: 20,
      webhooks: 3,
      eventReplayDays: 30,
      canPurchasePacks: true,
    },
  },
  team: {
    id: 'team',
    priceMonthlyKrw: 59_000,
    limits: {
      seats: 5,
      seatAddOnPriceKrw: 11_000,
      agents: null,
      automationMultiplier: 20,
      automationUnits: 1_000_000,
      realtimeConnections: 50,
      storageGb: 50,
      maxFileMb: 500,
      requestsPerMin: 1_200,
      automationRules: 100,
      webhooks: 10,
      eventReplayDays: 90,
      canPurchasePacks: true,
    },
  },
  business: {
    id: 'business',
    priceMonthlyKrw: 219_000,
    limits: {
      seats: 15,
      seatAddOnPriceKrw: 9_900,
      agents: null,
      automationMultiplier: 200,
      automationUnits: 10_000_000,
      realtimeConnections: 250,
      storageGb: 250,
      maxFileMb: 1_000,
      requestsPerMin: 6_000,
      automationRules: 1_000,
      webhooks: 100,
      eventReplayDays: 365,
      canPurchasePacks: true,
    },
  },
};

/** 연납 할인율 — 2개월분 무료(월환산 ~16.7% 할인) */
export const YEARLY_DISCOUNT_RATE = 1 / 6;

export function yearlyMonthlyEquivalentKrw(monthlyKrw: number): number {
  return Math.round((monthlyKrw * 12 * (1 - YEARLY_DISCOUNT_RATE)) / 12);
}

export const VAT_RATE = 0.1;

export function withVatKrw(krw: number): number {
  return Math.round(krw * (1 + VAT_RATE));
}

export function formatKrw(krw: number): string {
  return `${krw.toLocaleString('ko-KR')}원`;
}

export const AUTOMATION_PACK = { auPerPack: 150_000, priceKrwPerPack: 5_000, maxPacks: 5 } as const;
export const STORAGE_PACK = { gbPerPack: 10, priceKrwPerPack: 3_000, maxPacks: 3 } as const;

export type LimitAxisKey =
  | 'seats'
  | 'agents'
  | 'automation'
  | 'realtimeConnections'
  | 'storageGb'
  | 'maxFileMb'
  | 'requestsPerMin'
  | 'automationRules'
  | 'webhooks'
  | 'eventReplayDays'
  | 'support';

export const LIMIT_AXIS_ORDER: readonly LimitAxisKey[] = [
  'seats',
  'agents',
  'automation',
  'realtimeConnections',
  'storageGb',
  'maxFileMb',
  'requestsPerMin',
  'automationRules',
  'webhooks',
  'eventReplayDays',
  'support',
];
