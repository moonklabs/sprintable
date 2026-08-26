'use client';

import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  formatKrw,
  TIER_ORDER,
  type TierDefinition,
  type TierId,
} from './pricing-data';

function formatAutomationLabel(t: ReturnType<typeof useTranslations>, multiplier: number): string {
  if (multiplier <= 1) return t('automationMultiplierBase');
  return t('automationMultiplierOf', { n: multiplier });
}

function formatApplyDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function PricingPlanCard({
  tier,
  isPricePublic,
  isCurrent,
  currentTier,
  displayPriceMonthlyKrw,
  pendingTier,
  pendingChangeApplyAt,
  onUpgrade,
  onDowngrade,
  onCancel,
  onRevokePending,
}: {
  tier: TierDefinition;
  isPricePublic: boolean;
  isCurrent: boolean;
  /** 카드 방향(상향/하향) 판정에 필요 — 현재 구독 tier. */
  currentTier: TierId;
  /** 상태 B에서 렌더할 가격(월/연 토글 반영). 상태 A에서는 사용되지 않는다. */
  displayPriceMonthlyKrw: number;
  /** 예약된 변경의 대상 tier(#2881/#2882 공유 슬롯) — 이 카드가 그 대상이면 "예약됨"으로 그린다. */
  pendingTier: TierId | null;
  pendingChangeApplyAt: string | null;
  /** 유료→유료 상향(change-tier, 즉시 전액 청구+잔여 부분취소). */
  onUpgrade: (tierId: TierId) => void;
  /** 유료→유료 하향 예약(#2881, 다음 갱신일 적용). */
  onDowngrade: (tierId: TierId) => void;
  /** 구독 취소 예약(#2882, tier=free — 다음 갱신일 적용). */
  onCancel: () => void;
  onRevokePending: () => void;
}) {
  const t = useTranslations('pricingPlans');
  const { limits } = tier;

  // story #2909② — P0: 모든 비-current·비-free 카드가 항상 «업그레이드»였다(방향 무관).
  // 유료→유료 상향은 checkout이 아니라 change-tier(즉시 전액+부분취소)를 타야 하고,
  // 하위 tier는 «업그레이드»가 아니라 하향 예약(또는 free면 취소)이어야 한다.
  const isPendingTargetForThisCard = pendingTier != null && pendingTier === tier.id && !isCurrent;
  const isUpgrade = TIER_ORDER.indexOf(tier.id) > TIER_ORDER.indexOf(currentTier);

  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl border border-border bg-card p-4',
        isCurrent && 'border-brand ring-1 ring-brand',
      )}
    >
      {isCurrent && (
        <Badge variant="chip" className="absolute -top-2.5 left-4">
          {t('currentPlanBadge')}
        </Badge>
      )}
      {/* 유나양 발견(PR#3321 design 리뷰, 2026-08-21) — 이 코너 배지는 카드 하단의 방향
          판정 CTA와 별개 자리라 P0 fix가 안 훑었다. business/team 사용 org에는 starter가
          하향 대상인데도 «업그레이드» 라벨이 남아 있었다 — 이 PR의 존재 이유(오표기 소멸)
          자체를 반쪽으로 만드는 잔존 인스턴스라 같이 닫는다. */}
      {!isCurrent && isPricePublic && isUpgrade && tier.id === 'starter' && (
        <Badge variant="info" className="absolute -top-2.5 left-4">
          {t('upgradeCta')}
        </Badge>
      )}

      <div className="text-base font-semibold">{t(`tierName_${tier.id}`)}</div>
      <div className="mt-1 min-h-8 text-xs text-muted-foreground">{t(`tierPositioning_${tier.id}`)}</div>

      <div className="mt-3 flex min-h-11 items-baseline gap-1">
        {isPricePublic ? (
          <>
            <span className="text-2xl font-extrabold tracking-tight">{formatKrw(displayPriceMonthlyKrw)}</span>
            <span className="text-xs text-muted-foreground">{t('perMonth')}</span>
          </>
        ) : (
          <span className="inline-flex w-full items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm font-medium text-muted-foreground">
            {t('pricePendingPlaceholder')}
          </span>
        )}
      </div>
      {isPricePublic && (
        <div className="mb-1.5 text-[10px] text-muted-foreground">{t('vatExcludedNote')}</div>
      )}

      <div className="mb-3 text-xs text-muted-foreground">
        {t('seatsLabel', { count: limits.seats })}
        {limits.seatAddOnPriceKrw != null && <span className="ml-1">· {t('seatAddOnAvailable')}</span>}
      </div>

      {isCurrent ? (
        <Button variant="outline" size="sm" disabled className="mb-4 w-full border-dashed">
          {t('currentPlanCta')}
        </Button>
      ) : isPendingTargetForThisCard ? (
        <div className="mb-4 flex flex-col gap-1.5">
          <Badge variant="info" className="w-fit">
            {pendingChangeApplyAt
              ? t('pendingChangeBadge', { date: formatApplyDate(pendingChangeApplyAt) })
              : t('pendingChangeBadgeNoDate')}
          </Badge>
          <Button variant="outline" size="sm" className="w-full" onClick={onRevokePending}>
            {t('revokePendingCta')}
          </Button>
        </div>
      ) : isPricePublic && tier.id !== 'free' ? (
        isUpgrade ? (
          <Button variant="default" size="sm" className="mb-4 w-full bg-brand text-brand-foreground hover:bg-brand/90" onClick={() => onUpgrade(tier.id)}>
            {t('upgradeCta')}
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="mb-4 w-full" onClick={() => onDowngrade(tier.id)}>
            {t('downgradeCta')}
          </Button>
        )
      ) : isPricePublic && currentTier !== 'free' ? (
        // tier.id === 'free'이고 현재 유료 — 즉 이 카드는 «구독 취소»를 뜻한다(#2882,
        // tier=free로의 하향 예약과 동형).
        <Button variant="outline" size="sm" className="mb-4 w-full" onClick={onCancel}>
          {t('cancelSubscriptionCta')}
        </Button>
      ) : isPricePublic ? (
        <div className="mb-4 h-8 w-full" aria-hidden="true" />
      ) : (
        <Button variant="ghost" size="sm" disabled className="mb-4 w-full bg-muted text-muted-foreground">
          <Lock className="h-3.5 w-3.5" data-icon="inline-start" />
          {t('comingSoonCta')}
        </Button>
      )}

      <ul className="flex flex-col gap-2 text-xs">
        <li className="flex items-start gap-2">
          <span className="min-w-[4.5rem] text-muted-foreground">{t('featureAutomation')}</span>
          <span className="font-semibold text-brand">{formatAutomationLabel(t, limits.automationMultiplier)}</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="min-w-[4.5rem] text-muted-foreground">{t('featureStorage')}</span>
          <span className="font-semibold">{limits.storageGb}GB</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="min-w-[4.5rem] text-muted-foreground">{t('featureRealtimeConnections')}</span>
          <span className="font-semibold">{limits.realtimeConnections}</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="min-w-[4.5rem] text-muted-foreground">{t('featureAgents')}</span>
          <span className="font-semibold">{limits.agents == null ? t('agentsUnlimited') : limits.agents}</span>
        </li>
      </ul>

      <div className={cn('mt-3 border-t border-dashed border-border pt-3 text-[11px]', limits.canPurchasePacks ? 'text-success' : 'text-warning-strong')}>
        {limits.canPurchasePacks ? t('reachGo') : t('reachStopFree')}
      </div>
    </div>
  );
}
