'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { formatMinorCurrency, formatCount, type GenerationBudgetCurrency } from '@/components/content/generation-budget-indicator';
import type { OrgCostSummaryLoadState } from './org-cost-summary-card';
import type { Ga4ConnectionStatus, PublishedInWindow, ViewsInWindow } from './types';

/**
 * story #3979(시안 ④ 첫 화면 요약 4칸) — 3977 그라운딩 §1·§7 그대로: 조회는
 * insights-board 응답의 views_in_window(자연 D+7 합계, 서버 집계 — rows[] 페이지
 * 합산 금지, 페드루 PO 2026-09-17 00:52Z), 쓴 광고비/남은 한도는 cost-summary의
 * ads.*(org-cost-summary-card.tsx와 같은 통화 안전 계약 재사용). 나간 글은
 * published_in_window(story #3978, PR#4374 — 이 카드 작성 시점 develop 미착지라
 * 응답에 키 자체가 없을 수 있다 — 그때도 「미측정」으로 짓는다).
 *
 * story #3979 CHANGES(페드루 PO 2026-09-17 01:14Z) — cost-summary는 이 컴포넌트가
 * 더 이상 직접 fetch하지 않는다(페이지가 1회만 불러 내려준다, AC3 ≤2콜). 로딩/
 * 실패 상태를 「미측정」으로 오분류하던 결함도 여기서 같이 처방 — 로딩=Skeleton·
 * 실패=문구+보이는 재시도·「미측정+CTA」는 ok 응답+approved_boost_count===0일 때만.
 *
 * §⑤ 규율(doc a699be00) 그대로: 없는 수를 0으로 안 그린다 — 실측이면 수, 아니면
 * 「미측정」(+연결 축이 있는 칸만 연결 CTA, 나간 글은 연결 개념이 없어 CTA 없음).
 */
export interface ResultsSummaryCardsProps {
  publishedInWindow: PublishedInWindow | null;
  viewsInWindow: ViewsInWindow | null;
  ga4ConnectionStatus: Ga4ConnectionStatus;
  costSummaryState: OrgCostSummaryLoadState;
  onRetryCostSummary: () => void;
}

export function ResultsSummaryCards({ publishedInWindow, viewsInWindow, ga4ConnectionStatus, costSummaryState, onRetryCostSummary }: ResultsSummaryCardsProps) {
  const t = useTranslations('insightsBoard');
  const tContent = useTranslations('content');
  const tCommon = useTranslations('common');
  const locale = useLocale();

  const ads = costSummaryState.status === 'ok' ? costSummaryState.summary.ads : null;
  const adsMeasured = ads !== null && ads.approved_boost_count > 0;
  const adsCurrency = ads?.sealed_ads_currency as GenerationBudgetCurrency | null;
  const adsCurrencyMixed = adsMeasured && adsCurrency === null;
  const ga4Disconnected = ga4ConnectionStatus !== 'connected';

  function renderAdsCardBody(kind: 'spend' | 'remaining') {
    if (costSummaryState.status === 'loading') {
      return <Skeleton className="h-6 w-20" data-testid={`results-summary-ads-${kind}-loading`} />;
    }
    if (costSummaryState.status === 'failed') {
      return (
        <>
          <p className="text-muted-foreground" data-testid={`results-summary-ads-${kind}-failed`}>{t('orgCostLoadFailed')}</p>
          <Button size="sm" variant="outline" onClick={onRetryCostSummary} data-testid={`results-summary-ads-${kind}-retry`}>
            {tCommon('retry')}
          </Button>
        </>
      );
    }
    if (adsMeasured && ads) {
      if (adsCurrencyMixed) {
        return <p className="text-muted-foreground" data-testid={`results-summary-ads-${kind}-mixed`}>{t('orgCostAdsCurrencyMixed')}</p>;
      }
      const amount = kind === 'spend' ? ads.captured_spend_minor ?? 0 : ads.remaining_minor ?? 0;
      return (
        <p className="text-lg font-medium text-foreground" data-testid={`results-summary-ads-${kind}-value`}>
          {formatMinorCurrency(amount, adsCurrency as GenerationBudgetCurrency, locale, tContent)}
        </p>
      );
    }
    return (
      <>
        <p className="text-muted-foreground" data-testid={`results-summary-ads-${kind}-unmeasured`}>
          {t('reconcileVerdictUnmeasured')}
        </p>
        <Link href="/organization/channels" className="text-primary underline" data-testid={`results-summary-ads-${kind}-cta`}>
          {t('resultsSummaryConnectCta')}
        </Link>
      </>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="results-summary-cards">
      {/* 나간 글 — story #3978 의존, 연결 CTA 없음(응답 필드 유무 문제일 뿐 "연결"
          개념이 없다). */}
      <Card className="p-3 text-xs" data-testid="results-summary-published">
        <p className="mb-1 text-muted-foreground">{t('resultsSummaryPublishedLabel')}</p>
        {publishedInWindow ? (
          <p className="text-lg font-medium text-foreground" data-testid="results-summary-published-value">
            {formatCount(publishedInWindow.count, locale)}
          </p>
        ) : (
          <p className="text-muted-foreground" data-testid="results-summary-published-unmeasured">
            {t('reconcileVerdictUnmeasured')}
          </p>
        )}
      </Card>

      {/* 자연 조회 — views_in_window.sum(자연 D+7만, 페드루 정정 2026-09-17 00:57Z). */}
      <Card className="p-3 text-xs" data-testid="results-summary-organic-views">
        <p className="mb-1 text-muted-foreground">{t('resultsSummaryOrganicViewsLabel')}</p>
        {viewsInWindow ? (
          <>
            <p className="text-lg font-medium text-foreground" data-testid="results-summary-organic-views-value">
              {formatCount(viewsInWindow.sum, locale)}
            </p>
            {viewsInWindow.captured_rows < viewsInWindow.total_rows ? (
              <p className="text-muted-foreground" data-testid="results-summary-organic-views-partial">
                {t('resultsSummaryPartialCaptureNote', { captured: viewsInWindow.captured_rows, total: viewsInWindow.total_rows })}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-muted-foreground" data-testid="results-summary-organic-views-unmeasured">
              {t('reconcileVerdictUnmeasured')}
            </p>
            {ga4Disconnected ? (
              <Link href="/organization/channels" className="text-primary underline" data-testid="results-summary-organic-views-cta">
                {t('resultsSummaryConnectCta')}
              </Link>
            ) : null}
          </>
        )}
      </Card>

      {/* 쓴 광고비 / 남은 한도 — cost-summary ads.*(org-cost-summary-card.tsx와 같은
          통화 안전 계약). 로딩/실패는 별 분기(위 renderAdsCardBody) — 「미측정」은
          ok 응답+0건일 때만 뜬다(로딩·실패 중 번쩍이지 않는다). */}
      <Card className="p-3 text-xs" data-testid="results-summary-ads-spend">
        <p className="mb-1 text-muted-foreground">{t('resultsSummarySpendLabel')}</p>
        {renderAdsCardBody('spend')}
      </Card>

      <Card className="p-3 text-xs" data-testid="results-summary-ads-remaining">
        <p className="mb-1 text-muted-foreground">{t('resultsSummaryRemainingLabel')}</p>
        {renderAdsCardBody('remaining')}
      </Card>
    </div>
  );
}
