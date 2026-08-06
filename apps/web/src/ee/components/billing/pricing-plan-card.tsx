'use client';

import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  formatKrw,
  type TierDefinition,
  type TierId,
} from './pricing-data';

function formatAutomationLabel(t: ReturnType<typeof useTranslations>, multiplier: number): string {
  if (multiplier <= 1) return t('automationMultiplierBase');
  return t('automationMultiplierOf', { n: multiplier });
}

export function PricingPlanCard({
  tier,
  isPricePublic,
  isCurrent,
  displayPriceMonthlyKrw,
  onUpgrade,
}: {
  tier: TierDefinition;
  isPricePublic: boolean;
  isCurrent: boolean;
  /** 상태 B에서 렌더할 가격(월/연 토글 반영). 상태 A에서는 사용되지 않는다. */
  displayPriceMonthlyKrw: number;
  onUpgrade: (tierId: TierId) => void;
}) {
  const t = useTranslations('pricingPlans');
  const { limits } = tier;

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
      {!isCurrent && isPricePublic && tier.id === 'starter' && (
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

      <div className="mb-3 text-xs text-muted-foreground">
        {t('seatsLabel', { count: limits.seats })}
        {limits.seatAddOnPriceKrw != null && <span className="ml-1">· {t('seatAddOnAvailable')}</span>}
      </div>

      {isCurrent ? (
        <Button variant="outline" size="sm" disabled className="mb-4 w-full border-dashed">
          {t('currentPlanCta')}
        </Button>
      ) : isPricePublic ? (
        <Button variant="default" size="sm" className="mb-4 w-full bg-brand text-brand-foreground hover:bg-brand/90" onClick={() => onUpgrade(tier.id)}>
          {t('upgradeCta')}
        </Button>
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

      <div className={cn('mt-3 border-t border-dashed border-border pt-3 text-[11px]', limits.canPurchasePacks ? 'text-success' : 'text-warning')}>
        {limits.canPurchasePacks ? t('reachGo') : t('reachStopFree')}
      </div>
    </div>
  );
}
