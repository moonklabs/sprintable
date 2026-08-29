'use client';

/**
 * EE-only Billing tab — 결제② D단계 재편 (v2.3 · 4티어 · KRW · Toss · 팩).
 * isEEEnabled()=true 환경에서만 렌더링됨. 유나 시안(artifact a1bd79ae) + 핸드오프 doc
 * (billing2-ui-handoff-v1) SSOT.
 *
 * isPricePublic/checkoutEnabled — story #2728(선생님 결정③, 2026-08-18): 가변값은 어드민
 * 관리(하드코딩 금지). `GET /api/v2/platform-settings`에서 fetch — 둘 다 기본 false(Toss
 * 심사 완료 前 prod 결제표면 전면 차단, 결정②). 이전 하드코드 `IS_PRICE_PUBLIC = true`는
 * 이 스토리가 지우는 그 위반 자체다(⛔실제로 prod에 가격이 노출되고 있었음).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
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
import { fetchWithAuth } from '@/lib/db/client';
import { PricingPlanCard } from './pricing-plan-card';
import { PricingLimitsTable } from './pricing-limits-table';
import { PricingPacks, type PackKind } from './pricing-packs';
import { completeCheckout, startBillingAuth, type CheckoutOutcome } from './toss-checkout';
import { PaymentMethodSection } from './payment-method-section';
import { OrderHistorySection } from './order-history-section';
import {
  cancelSubscription,
  changeTier,
  reserveDowngrade,
  revokePendingChange,
  type ChangeTierOutcome,
} from './billing-actions';
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

interface PlatformSettings {
  billing_price_public: boolean;
  billing_checkout_enabled: boolean;
}

interface BillingStatus {
  org_id: string;
  tier: string;
  billing_cycle: string | null;
  status: string;
  current_period_end: string | null;
  can_manage: boolean;
  /** story #2909② — 하향(#2881)/취소(#2882) 예약 슬롯 공유. 'free'=취소, 그 외=하향. */
  pending_tier: string | null;
  pending_change_apply_at: string | null;
}

function toTierId(raw: string | undefined): TierId {
  // story #2403 후속(2026-08-17) — prod org_subscriptions 실측: tier='pro'(레거시 Polar,
  // v2.2 D5가 은퇴시킨 이름) 조직이 3건 실존. TIER_ORDER에 'pro'가 없어 이 매핑 없이는
  // 유료 결제 중인 조직이 조용히 "Free"로 렌더됐다(실해악 — 화면만 틀리고 청구는 계속됨).
  // 'business'로 매핑하는 근거: migration 0228이 이미 pricing_versions에 동일 판단을
  // 적용했다(`UPDATE pricing_versions SET tier = 'business' WHERE tier = 'pro'`) — 이름
  // 재사용 금지(D12)는 신규 의미 부여 금지이지, 레거시 데이터 표시 매핑까지 막지 않는다.
  if (raw === 'pro') return 'business';
  return raw != null && (TIER_ORDER as readonly string[]).includes(raw) ? (raw as TierId) : 'free';
}

export function BillingTab({ orgId }: { orgId: string }) {
  const t = useTranslations('pricingPlans');
  const tc = useTranslations('common');
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [platformSettings, setPlatformSettings] = useState<PlatformSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [upgradeTarget, setUpgradeTarget] = useState<TierId | null>(null);
  const [packTarget, setPackTarget] = useState<{ kind: PackKind; quantity: number } | null>(null);
  const [checkoutProcessing, setCheckoutProcessing] = useState(false);
  const [checkoutOutcome, setCheckoutOutcome] = useState<CheckoutOutcome | { kind: 'widgetFailed' } | null>(null);
  // story #2909② — 유료→유료 상향(change-tier)/하향 예약/취소 예약. 신규 결제(checkout,
  // 위 upgradeTarget)와 별개 진입점 — 셋 다 authKey/위젯 리다이렉트가 없다.
  const [changeTierTarget, setChangeTierTarget] = useState<Exclude<TierId, 'free'> | null>(null);
  const [downgradeTarget, setDowngradeTarget] = useState<Exclude<TierId, 'free'> | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  const refetchStatus = () => {
    setLoading(true);
    // story #40659941(#2728 픽셀 검증 블로커) — FASTAPI_URL 직접 fetch는 CSP connect-src에
    // 막힌다(브라우저→백엔드 origin 직행 금지). same-origin /api 프록시 경유로 수렴 +
    // fetchWithAuth(콜드마운트 자동발화 GET이라 raw fetch 금지, #2689/#2691 가드).
    fetchWithAuth('/api/billing/status', { credentials: 'include' })
      .then((r) => r.json() as Promise<{ data: BillingStatus }>)
      .then((json) => setStatus(json.data))
      .catch(() => setError(t('loadError')))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  useEffect(() => {
    // story #2728 — 미기입/fetch 실패 시 안전측 기본값(둘 다 false, 노출 안 함)으로
    // 폴백한다. "못 읽으면 일단 켜서 보여준다"는 이 스위치의 존재 이유(prod 결제표면
    // 전면 차단)를 정반대로 무력화한다.
    fetchWithAuth('/api/platform-settings', { credentials: 'include' })
      .then((r) => r.ok ? (r.json() as Promise<{ data: PlatformSettings }>) : null)
      .then((json) => setPlatformSettings(json?.data ?? { billing_price_public: false, billing_checkout_enabled: false }))
      .catch(() => setPlatformSettings({ billing_price_public: false, billing_checkout_enabled: false }));
  }, []);

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
  // pending_tier는 항상 BE가 유효한 TierId 문자열만 낸다(#2881/#2882 자체가 카탈로그
  // 존재 확認 후 기입) — toTierId의 pro→business 레거시 매핑 대상이 아니다.
  const pendingTierId = (status?.pending_tier as TierId | null | undefined) ?? null;
  const canManage = status?.can_manage ?? false;
  const isPricePublic = platformSettings?.billing_price_public ?? false;
  const checkoutEnabled = platformSettings?.billing_checkout_enabled ?? false;

  return (
    <div className="space-y-6 p-6">
      {!isPricePublic && (
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

      <PaymentMethodSection canManage={canManage} />
      <OrderHistorySection canManage={canManage} />

      {isPricePublic && (
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
              isPricePublic={isPricePublic}
              isCurrent={tierId === currentTier}
              currentTier={currentTier}
              displayPriceMonthlyKrw={displayPriceMonthlyKrw}
              pendingTier={pendingTierId}
              pendingChangeApplyAt={status?.pending_change_apply_at ?? null}
              onUpgrade={(target) => {
                if (!canManage || !checkoutEnabled || target === 'free') return;
                // story #2909② P0 — currentTier가 이미 유료면 checkout(신규 결제)이 아니라
                // change-tier(기존 billing_key로 즉시 전액+잔여 부분취소)를 타야 한다.
                // checkout은 BE가 이제 활성 유료 org 재진입을 400으로 거부한다(#2909①).
                if (currentTier === 'free') {
                  setUpgradeTarget(target);
                } else {
                  setChangeTierTarget(target as Exclude<TierId, 'free'>);
                }
              }}
              onDowngrade={(target) => {
                if (!canManage || !checkoutEnabled || target === 'free') return;
                setDowngradeTarget(target as Exclude<TierId, 'free'>);
              }}
              onCancel={() => canManage && checkoutEnabled && setCancelDialogOpen(true)}
              onRevokePending={() => {
                if (!canManage || !checkoutEnabled) return;
                revokePendingChange().then(() => refetchStatus());
              }}
            />
          );
        })}
      </div>

      <PricingLimitsTable currentTier={currentTier} />

      {/* 팩 실가격(원)도 대표 승인 게이트 대상 — canPurchasePacks만 보면 승인 前에도 team/business
          티어에서 실 KRW 가격이 샌다(카디르 QA #2866 발견). isPricePublic 없이는 살 것 자체가 없다. */}
      {isPricePublic && TIER_DEFINITIONS[currentTier].limits.canPurchasePacks && (
        <PricingPacks onBuyPack={(kind, quantity) => canManage && checkoutEnabled && setPackTarget({ kind, quantity })} />
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
      <ChangeTierConfirmDialog
        tierId={changeTierTarget}
        onClose={() => setChangeTierTarget(null)}
        onDone={() => refetchStatus()}
      />
      <DowngradeConfirmDialog
        tierId={downgradeTarget}
        onClose={() => setDowngradeTarget(null)}
        onDone={() => refetchStatus()}
      />
      <CancelSubscriptionConfirmDialog
        open={cancelDialogOpen}
        currentTierName={t(`tierName_${currentTier}`)}
        onClose={() => setCancelDialogOpen(false)}
        onDone={() => refetchStatus()}
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
        {/* story #2606 AC4: 결제 화면에서 환불정책 확인 가능(Toss 심사 요건) — 확인 버튼 바로 위. */}
        <p className="text-[11px] text-muted-foreground">
          {t('checkoutDialogRefundPolicyPrefix')}{' '}
          <Link href="/refund-policy" target="_blank" className="underline hover:text-foreground/80">
            {t('checkoutDialogRefundPolicyLink')}
          </Link>
          {t('checkoutDialogRefundPolicySuffix')}
        </p>
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

/**
 * story #2909②(P0) — 유료→유료 상향. checkout(위 UpgradeCheckoutDialog)과 달리 위젯
 * 리다이렉트가 없다(기존 billing_key 재사용, 즉시 완결) — 문안은 페드루군 지시대로
 * "신 요금 전액 결제+기존 잔여 일할 부분취소"를 명시(고객이 «왜 두 번 청구/환불처럼
 * 보이는 일이 동시에 생기는지» 미리 이해하게).
 */
function ChangeTierConfirmDialog({
  tierId,
  onClose,
  onDone,
}: {
  tierId: Exclude<TierId, 'free'> | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('pricingPlans');
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<ChangeTierOutcome | null>(null);
  if (tierId == null) return null;
  const tier = TIER_DEFINITIONS[tierId];
  const chargeKrw = withVatKrw(tier.priceMonthlyKrw);

  const handleConfirm = () => {
    if (submitting) return;
    setSubmitting(true);
    setOutcome(null);
    changeTier(tierId)
      .then((result) => {
        setOutcome(result);
        setSubmitting(false);
        if (result.kind === 'active') {
          onDone();
          onClose();
        }
      })
      .catch(() => {
        setOutcome({ kind: 'error', status: 0 });
        setSubmitting(false);
      });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('changeTierDialogTitle', { tier: t(`tierName_${tierId}`) })}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('changeTierDialogExplain')}</p>
        <dl className="divide-y divide-border text-sm">
          <div className="flex justify-between py-2">
            <dt className="text-muted-foreground">{t('checkoutDialogChargeLabel')}</dt>
            <dd className="font-semibold">{t('checkoutDialogChargeValue', { amount: formatKrw(chargeKrw) })}</dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="text-muted-foreground">{t('changeTierDialogRefundLabel')}</dt>
            <dd className="font-semibold">{t('changeTierDialogRefundValue')}</dd>
          </div>
        </dl>
        {outcome?.kind === 'declined' && (
          <Alert variant="warning">
            <AlertDescription>{t('checkoutDeclinedBanner', { reason: outcome.result.declined_reason ?? '' })}</AlertDescription>
          </Alert>
        )}
        {outcome?.kind === 'error' && (
          <Alert variant="destructive">
            <AlertDescription>{t('checkoutErrorBanner')}</AlertDescription>
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
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" data-icon="inline-start" /> : null}
            {t('changeTierDialogConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** story #2909②(하위 tier 카드) — 유료→유료 하향 예약(#2881). 즉시 전이 없음·부분 환불 없음. */
function DowngradeConfirmDialog({
  tierId,
  onClose,
  onDone,
}: {
  tierId: Exclude<TierId, 'free'> | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('pricingPlans');
  const [submitting, setSubmitting] = useState(false);
  const [errored, setErrored] = useState(false);
  if (tierId == null) return null;

  const handleConfirm = () => {
    if (submitting) return;
    setSubmitting(true);
    setErrored(false);
    reserveDowngrade(tierId)
      .then((result) => {
        setSubmitting(false);
        if (result.kind === 'active') {
          onDone();
          onClose();
        } else {
          setErrored(true);
        }
      })
      .catch(() => {
        setSubmitting(false);
        setErrored(true);
      });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('downgradeDialogTitle', { tier: t(`tierName_${tierId}`) })}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('downgradeDialogExplain')}</p>
        {errored && (
          <Alert variant="destructive">
            <AlertDescription>{t('checkoutErrorBanner')}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t('checkoutDialogCancel')}
          </Button>
          <Button variant="default" onClick={handleConfirm} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" data-icon="inline-start" /> : null}
            {t('downgradeDialogConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** story #2909②(free 카드=취소, #2882) — 「현재 기간 말까지 사용, 다음 갱신 중지」. */
function CancelSubscriptionConfirmDialog({
  open,
  currentTierName,
  onClose,
  onDone,
}: {
  open: boolean;
  currentTierName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('pricingPlans');
  const [submitting, setSubmitting] = useState(false);
  const [errored, setErrored] = useState(false);
  if (!open) return null;

  const handleConfirm = () => {
    if (submitting) return;
    setSubmitting(true);
    setErrored(false);
    cancelSubscription()
      .then((result) => {
        setSubmitting(false);
        if (result.kind === 'active') {
          onDone();
          onClose();
        } else {
          setErrored(true);
        }
      })
      .catch(() => {
        setSubmitting(false);
        setErrored(true);
      });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('cancelDialogTitle')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('cancelDialogExplain', { tier: currentTierName })}</p>
        {errored && (
          <Alert variant="destructive">
            <AlertDescription>{t('checkoutErrorBanner')}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t('cancelDialogKeepPlan')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" data-icon="inline-start" /> : null}
            {t('cancelDialogConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PackPurchaseDialog({
  target,
  onClose,
}: {
  target: { kind: PackKind; quantity: number } | null;
  onClose: () => void;
}) {
  const t = useTranslations('pricingPlans');
  if (target == null) return null;
  const pack = target.kind === 'automation' ? AUTOMATION_PACK : STORAGE_PACK;
  // story #3097(선생님 결정 2026-08-26) — v2.3 확정가=공급가, 청구 시점 VAT 10% 가산이
  // BE(billing_pack.py::purchase_packs)에 이제 실제로 걸린다 — 이 확인창은 UpgradeCheckoutDialog/
  // ChangeTierConfirmDialog와 동일 원칙(청구 직전 확인창=실 청구액을 그대로 보여준다)을
  // 따라 withVatKrw를 적용한다. 마케팅 카탈로그(pricing-plan-card.tsx/pricing-packs.tsx)는
  // 확정가(공급가)를 그대로 보이는 게 맞아 별개 — 그쪽은 안 건드림.
  const priceKrw = withVatKrw(pack.priceKrwPerPack * target.quantity);
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
        <p className="text-[11px] text-muted-foreground">{t('packDialogComingSoonNote')}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('packDialogCancel')}
          </Button>
          {/* story #3211 — 실 결제/원장 기입(결제②-C TossAdapter+A2 Ledger)이 배선되기
              전까지 표면 차단(PO 확定 (b)안). 조용한 무동작 금지 — disabled로 "안 눌리는
              이유"를 explicit하게 보여준다(준비 중 라벨). 유나 design:changes(PR#3613) —
              brand fill+opacity-50 조합은 라벨 대비가 양테마 ~2:1로 이 판의 목적(왜 못
              사는지 읽히기)과 자가당착이라 secondary variant로 교체. */}
          <Button variant="secondary" disabled title={t('packDialogComingSoon')}>
            {t('packDialogComingSoon')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
