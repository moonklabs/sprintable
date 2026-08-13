'use client';

/**
 * EE-only Billing tab — 결제② D단계 재편 (v2.3 · 4티어 · KRW · Toss · 팩).
 * isEEEnabled()=true 환경에서만 렌더링됨. 유나 시안(artifact a1bd79ae) + 핸드오프 doc
 * (billing2-ui-handoff-v1) SSOT.
 *
 * isPricePublic — 대표 승인 게이트의 진실은 서버 필드(#2474 A관리1 BE)가 최종형이나, 그 API
 * 착지 前까지는 하드코드로 켠다(story #2605 그라운딩: 렌더 경로가 TIER_DEFINITIONS 로컬 상수만
 * 읽고 #2474 API를 호출하는 자리가 코드 어디에도 없음을 확認 — 이 상수는 "API 부재로 대신 켜는
 * 로컬 값"일 뿐, #2474가 기능적으로 선결조건은 아니다). 대표 승인 완료(2026-08-13) 반영.
 * #2474 착지 후 이 상수를 실 플래그 fetch 로 교체하는 것이 유일한 변경점이 되도록
 * 나머지 렌더 로직은 이미 isPricePublic 하나로 분기돼 있다.
 */

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
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
import { completeCheckout, startBillingAuth, type CheckoutOutcome } from './toss-checkout';
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

/** #2474 A관리1 BE 뜨기 前까지 하드코드 — 대표 승인 완료(2026-08-13, story #2605)로 켠다. */
const IS_PRICE_PUBLIC = true;

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [upgradeTarget, setUpgradeTarget] = useState<TierId | null>(null);
  const [packTarget, setPackTarget] = useState<{ kind: PackKind; quantity: number } | null>(null);
  const [checkoutProcessing, setCheckoutProcessing] = useState(false);
  const [checkoutOutcome, setCheckoutOutcome] = useState<CheckoutOutcome | { kind: 'widgetFailed' } | null>(null);

  const refetchStatus = () => {
    setLoading(true);
    fetch(`${FASTAPI_URL()}/api/v2/billing/status`, { credentials: 'include' })
      .then((r) => r.json() as Promise<BillingStatus>)
      .then(setStatus)
      .catch(() => setError(t('loadError')))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  // 결제②-D(#2510) — Toss 위젯 리다이렉트 왕복 복귀 처리. successUrl/failUrl 둘 다
  // /settings?tab=billing 으로 돌아오므로 여기서 쿼리파라미터로 왕복 결과를 판별한다.
  // 처리 後 즉시 쿼리를 지워 새로고침 시 같은 authKey로 이중 체크아웃되는 것을 막는다.
  useEffect(() => {
    const checkoutParam = searchParams.get('checkout');
    if (checkoutParam == null) return;

    const clearQuery = () => router.replace('/settings?tab=billing');

    if (checkoutParam === 'fail') {
      setCheckoutOutcome({ kind: 'widgetFailed' });
      clearQuery();
      return;
    }
    if (checkoutParam !== 'success') return;

    const authKey = searchParams.get('authKey');
    const tier = searchParams.get('tier');
    const billingCycleParam = searchParams.get('cycle');
    if (!authKey || !tier || (billingCycleParam !== 'monthly' && billingCycleParam !== 'annual')) {
      setCheckoutOutcome({ kind: 'widgetFailed' });
      clearQuery();
      return;
    }

    setCheckoutProcessing(true);
    completeCheckout({ authKey, tier: tier as Exclude<TierId, 'free'>, billingCycle: billingCycleParam })
      .then((outcome) => {
        setCheckoutOutcome(outcome);
        if (outcome.kind === 'active') refetchStatus();
      })
      .catch(() => setCheckoutOutcome({ kind: 'error', status: 0 }))
      .finally(() => {
        setCheckoutProcessing(false);
        clearQuery();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

      {checkoutProcessing && (
        <Alert variant="info">
          <AlertDescription className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('checkoutProcessing')}
          </AlertDescription>
        </Alert>
      )}

      {!checkoutProcessing && checkoutOutcome?.kind === 'active' && (
        <Alert variant="success">
          <AlertDescription>{t('checkoutSuccessBanner', { tier: t(`tierName_${checkoutOutcome.result.tier}`) })}</AlertDescription>
        </Alert>
      )}
      {!checkoutProcessing && checkoutOutcome?.kind === 'declined' && (
        // 유나 design 가디언(2026-08-07) — declined(카드거절)는 502 등 시스템오류와 색으로
        // 구분돼야 한다(내 카드 문제 vs 서비스 문제). destructive(red)가 아니라 warning.
        <Alert variant="warning">
          <AlertDescription>
            {t('checkoutDeclinedBanner', { reason: checkoutOutcome.result.declined_reason ?? '' })}
            {' '}
            {t('checkoutDeclinedReassurance')}
          </AlertDescription>
        </Alert>
      )}
      {!checkoutProcessing && checkoutOutcome?.kind === 'error' && (
        <Alert variant="destructive">
          <AlertDescription>{t('checkoutErrorBanner')}</AlertDescription>
        </Alert>
      )}
      {!checkoutProcessing && checkoutOutcome?.kind === 'widgetFailed' && (
        <Alert variant="destructive">
          <AlertDescription>{t('checkoutWidgetFailedBanner')}</AlertDescription>
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

export function UpgradeCheckoutDialog({
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
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  if (tierId == null || tierId === 'free') return null;
  const tier = TIER_DEFINITIONS[tierId];
  const monthlyKrw = cycle === 'yearly' ? yearlyMonthlyEquivalentKrw(tier.priceMonthlyKrw) : tier.priceMonthlyKrw;
  const chargeKrw = withVatKrw(monthlyKrw);
  const nextBillingDay = new Date().getDate();

  // story #2510 — 위젯이 열리면 이 페이지를 이탈하므로 정상 흐름에서 setSubmitting(false)로
  // 돌아오지 않는다(리다이렉트 복귀 後 새 마운트가 처리). 실패(예: 카드 인증창 자체가 안
  // 열림)만 여기서 잡아 재시도 가능한 상태로 되돌린다 — 이중제출 방어(유나 시안 v2).
  const handleConfirm = () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(false);
    startBillingAuth({ tier: tierId, cycle }).catch(() => {
      setSubmitting(false);
      setSubmitError(true);
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
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
        {submitError && (
          <Alert variant="destructive">
            <AlertDescription>{t('checkoutWidgetOpenErrorInline')}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t('checkoutDialogCancel')}
          </Button>
          <Button
            variant="default"
            className="bg-brand text-brand-foreground hover:bg-brand/90"
            onClick={handleConfirm}
            disabled={submitting}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" data-icon="inline-start" />
            ) : null}
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
