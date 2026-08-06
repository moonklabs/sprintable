'use client';

/**
 * EE-only Billing tab — 결제② D단계 재편 (v2.3 · 4티어 · KRW · Toss · 팩).
 * isEEEnabled()=true 환경에서만 렌더링됨. 유나 시안(artifact a1bd79ae) + 핸드오프 doc
 * (billing2-ui-handoff-v1) SSOT.
 *
 * isPricePublic — 대표 승인 게이트의 진실은 서버 필드(#2474 A관리1 BE)여야 하나, 그 API가
 * 아직 없어 지금은 하드코드 false 로 고정한다(승인 前 실가격 대외 노출 0 원칙).
 * #2474 착지 후 이 상수를 실 플래그 fetch 로 교체하는 것이 유일한 변경점이 되도록
 * 나머지 렌더 로직은 이미 isPricePublic 하나로 분기돼 있다.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { PricingPlanCard } from './pricing-plan-card';
import { PricingLimitsTable } from './pricing-limits-table';
import { PricingPacks, type PackKind } from './pricing-packs';
import {
  AUTOMATION_PACK,
  STORAGE_PACK,
  TIER_DEFINITIONS,
  TIER_ORDER,
  formatKrw,
  withVatKrw,
  yearlyMonthlyEquivalentKrw,
  type TierId,
} from './pricing-data';

/** #2474 A관리1 BE 뜨기 前까지 하드코드 — 승인 前 실가격 대외 노출 0. */
const IS_PRICE_PUBLIC = false;

interface BillingStatus {
  org_id: string;
  tier: string;
  billing_cycle: string | null;
  status: string;
  current_period_end: string | null;
  can_manage: boolean;
}

const FASTAPI_URL = () => process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? 'http://localhost:8000';

function toTierId(raw: string | undefined): TierId {
  return raw != null && (TIER_ORDER as readonly string[]).includes(raw) ? (raw as TierId) : 'free';
}

export function BillingTab({ orgId }: { orgId: string }) {
  const t = useTranslations('pricingPlans');
  const tc = useTranslations('common');
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [upgradeTarget, setUpgradeTarget] = useState<TierId | null>(null);
  const [packTarget, setPackTarget] = useState<{ kind: PackKind; quantity: number } | null>(null);

  useEffect(() => {
    fetch(`${FASTAPI_URL()}/api/v2/billing/status`, { credentials: 'include' })
      .then((r) => r.json() as Promise<BillingStatus>)
      .then(setStatus)
      .catch(() => setError(t('loadError')))
      .finally(() => setLoading(false));
  }, [orgId, t]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {tc('loading')}
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const currentTier = toTierId(status?.tier);
  const canManage = status?.can_manage ?? false;

  return (
    <div className="space-y-6 p-6">
      {!IS_PRICE_PUBLIC && (
        <Alert variant="info">
          <AlertDescription>{t('statePendingBanner')}</AlertDescription>
        </Alert>
      )}

      {IS_PRICE_PUBLIC && (
        <Tabs value={cycle} onValueChange={(v) => setCycle(v as 'monthly' | 'yearly')}>
          <div className="flex items-center gap-3">
            <TabsList>
              <TabsTrigger value="monthly">{t('monthlyToggle')}</TabsTrigger>
              <TabsTrigger value="yearly">{t('yearlyToggle')}</TabsTrigger>
            </TabsList>
            {cycle === 'yearly' && <span className="text-xs font-medium text-success">{t('yearlySaveNote')}</span>}
          </div>
        </Tabs>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {TIER_ORDER.map((tierId) => {
          const tier = TIER_DEFINITIONS[tierId];
          const displayPriceMonthlyKrw = cycle === 'yearly' ? yearlyMonthlyEquivalentKrw(tier.priceMonthlyKrw) : tier.priceMonthlyKrw;
          return (
            <PricingPlanCard
              key={tierId}
              tier={tier}
              isPricePublic={IS_PRICE_PUBLIC}
              isCurrent={tierId === currentTier}
              displayPriceMonthlyKrw={displayPriceMonthlyKrw}
              onUpgrade={(target) => canManage && setUpgradeTarget(target)}
            />
          );
        })}
      </div>

      <PricingLimitsTable currentTier={currentTier} />

      {/* 팩 실가격(원)도 대표 승인 게이트 대상 — canPurchasePacks만 보면 승인 前에도 team/business
          티어에서 실 KRW 가격이 샌다(카디르 QA #2866 발견). isPricePublic 없이는 살 것 자체가 없다. */}
      {IS_PRICE_PUBLIC && TIER_DEFINITIONS[currentTier].limits.canPurchasePacks && (
        <PricingPacks onBuyPack={(kind, quantity) => canManage && setPackTarget({ kind, quantity })} />
      )}

      {!canManage && (
        <Alert variant="default">
          <AlertDescription>{t('memberNotice')}</AlertDescription>
        </Alert>
      )}

      <UpgradeCheckoutDialog
        tierId={upgradeTarget}
        cycle={cycle}
        currentSeats={TIER_DEFINITIONS[currentTier].limits.seats}
        onClose={() => setUpgradeTarget(null)}
      />
      <PackPurchaseDialog target={packTarget} onClose={() => setPackTarget(null)} />
    </div>
  );
}

function UpgradeCheckoutDialog({
  tierId,
  cycle,
  currentSeats,
  onClose,
}: {
  tierId: TierId | null;
  cycle: 'monthly' | 'yearly';
  currentSeats: number;
  onClose: () => void;
}) {
  const t = useTranslations('pricingPlans');
  if (tierId == null) return null;
  const tier = TIER_DEFINITIONS[tierId];
  const monthlyKrw = cycle === 'yearly' ? yearlyMonthlyEquivalentKrw(tier.priceMonthlyKrw) : tier.priceMonthlyKrw;
  const chargeKrw = withVatKrw(monthlyKrw);
  const nextBillingDay = new Date().getDate();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('checkoutDialogTitle', { tier: t(`tierName_${tierId}`) })}</DialogTitle>
        </DialogHeader>
        <dl className="divide-y divide-border text-sm">
          <div className="flex justify-between py-2">
            <dt className="text-muted-foreground">{t('checkoutDialogPlanLabel')}</dt>
            <dd className="font-semibold">{t('checkoutDialogPlanValue', { tier: t(`tierName_${tierId}`), cycle: t(cycle === 'monthly' ? 'monthlyToggle' : 'yearlyToggle') })}</dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="text-muted-foreground">{t('checkoutDialogSeatsLabel')}</dt>
            <dd className="font-semibold">{t('checkoutDialogSeatsCurrent', { count: currentSeats })}</dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="text-muted-foreground">{t('checkoutDialogChargeLabel')}</dt>
            <dd className="font-semibold">{t('checkoutDialogChargeValue', { amount: formatKrw(chargeKrw) })}</dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="text-muted-foreground">{t('checkoutDialogNextBillingLabel')}</dt>
            <dd className="font-semibold">{t('checkoutDialogNextBillingEveryMonth', { day: nextBillingDay })}</dd>
          </div>
        </dl>
        <p className="text-[11px] text-muted-foreground">{t('checkoutDialogTossNote')}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('checkoutDialogCancel')}
          </Button>
          {/* Toss 실결제 연동은 결제②-C(TossAdapter) 범위 — 그 前까지 셸만 확인용으로 닫는다. */}
          <Button variant="default" className="bg-brand text-brand-foreground hover:bg-brand/90" onClick={onClose}>
            {t('checkoutDialogConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PackPurchaseDialog({
  target,
  onClose,
}: {
  target: { kind: PackKind; quantity: number } | null;
  onClose: () => void;
}) {
  const t = useTranslations('pricingPlans');
  if (target == null) return null;
  const pack = target.kind === 'automation' ? AUTOMATION_PACK : STORAGE_PACK;
  const priceKrw = pack.priceKrwPerPack * target.quantity;
  const packTitleKey = target.kind === 'automation' ? 'automationPackTitle' : 'storagePackTitle';

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('packDialogTitle', { count: target.quantity, pack: t(packTitleKey) })}</DialogTitle>
        </DialogHeader>
        <dl className="divide-y divide-border text-sm">
          <div className="flex justify-between py-2">
            <dt className="text-muted-foreground">{t('packDialogAmountLabel')}</dt>
            <dd className="font-semibold">
              {target.kind === 'automation'
                ? t('packDialogAutomationAmount', { amount: (AUTOMATION_PACK.auPerPack * target.quantity).toLocaleString('ko-KR') })
                : t('packDialogStorageAmount', { amount: STORAGE_PACK.gbPerPack * target.quantity })}
            </dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="text-muted-foreground">{t('packDialogChargeLabel')}</dt>
            <dd className="font-semibold">{t('packDialogChargeValue', { price: formatKrw(priceKrw) })}</dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="text-muted-foreground">{t('packDialogAppliesLabel')}</dt>
            <dd className="font-semibold">{t('packDialogAppliesValue')}</dd>
          </div>
        </dl>
        <p className="text-[11px] text-muted-foreground">{t('packDialogNote')}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('packDialogCancel')}
          </Button>
          {/* 실 결제/원장 기입은 결제②-C(TossAdapter)+A2(Ledger) 범위 — 셸 확인용으로 닫는다. */}
          <Button variant="default" className="bg-brand text-brand-foreground hover:bg-brand/90" onClick={onClose}>
            {t('packDialogConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
