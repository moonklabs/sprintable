'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { fetchWithAuth } from '@/lib/db/client';
import { formatMinorCurrency, formatCount, type GenerationBudgetCurrency } from '@/components/content/generation-budget-indicator';
import type { Ga4ConnectionStatus, PublishedInWindow, ViewsInWindow } from './types';

/**
 * story #3979(시안 ④ 첫 화면 요약 4칸) — 3977 그라운딩 §1·§7 그대로: 조회는
 * insights-board 응답의 views_in_window(자연 D+7 합계, 서버 집계 — rows[] 페이지
 * 합산 금지, 페드루 PO 2026-09-17 00:52Z), 쓴 광고비/남은 한도는 cost-summary의
 * ads.*(org-cost-summary-card.tsx와 같은 통화 안전 계약 재사용). 나간 글은
 * published_in_window(story #3978, PR#4374 — 이 카드 작성 시점 develop 미착지라
 * 응답에 키 자체가 없을 수 있다 — 그때도 「미측정」으로 짓는다).
 *
 * §⑤ 규율(doc a699be00) 그대로: 없는 수를 0으로 안 그린다 — 실측이면 수, 아니면
 * 「미측정」(+연결 축이 있는 칸만 연결 CTA, 나간 글은 연결 개념이 없어 CTA 없음).
 */
interface AdsCostSummaryLite {
  approved_boost_count: number;
  sealed_ads_currency: string | null;
  captured_spend_minor: number | null;
  remaining_minor: number | null;
}

type AdsLoadState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ok'; ads: AdsCostSummaryLite };

export interface ResultsSummaryCardsProps {
  orgId: string;
  publishedInWindow: PublishedInWindow | null;
  viewsInWindow: ViewsInWindow | null;
  ga4ConnectionStatus: Ga4ConnectionStatus;
}

export function ResultsSummaryCards({ orgId, publishedInWindow, viewsInWindow, ga4ConnectionStatus }: ResultsSummaryCardsProps) {
  const t = useTranslations('insightsBoard');
  const tContent = useTranslations('content');
  const locale = useLocale();
  const [adsState, setAdsState] = useState<AdsLoadState>({ status: 'loading' });

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/insights-board/cost-summary`);
        if (cancelled) return;
        if (!res.ok) { setAdsState({ status: 'failed' }); return; }
        const json = (await res.json().catch(() => null)) as { data?: { ads?: AdsCostSummaryLite } } | null;
        if (!json?.data?.ads) { setAdsState({ status: 'failed' }); return; }
        setAdsState({ status: 'ok', ads: json.data.ads });
      } catch {
        if (!cancelled) setAdsState({ status: 'failed' });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [orgId]);

  const ads = adsState.status === 'ok' ? adsState.ads : null;
  const adsMeasured = ads !== null && ads.approved_boost_count > 0;
  const adsCurrency = ads?.sealed_ads_currency as GenerationBudgetCurrency | null;
  const adsCurrencyMixed = adsMeasured && adsCurrency === null;
  const ga4Disconnected = ga4ConnectionStatus !== 'connected';

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

      {/* 쓴 광고비 — cost-summary ads.captured_spend_minor(org-cost-summary-card.tsx와
          같은 통화 안전 계약: 0건=미측정, 통화 섞임=중립 문구, 그 외=실값). */}
      <Card className="p-3 text-xs" data-testid="results-summary-ads-spend">
        <p className="mb-1 text-muted-foreground">{t('resultsSummarySpendLabel')}</p>
        {adsMeasured && ads ? (
          adsCurrencyMixed ? (
            <p className="text-muted-foreground" data-testid="results-summary-ads-spend-mixed">{t('orgCostAdsCurrencyMixed')}</p>
          ) : (
            <p className="text-lg font-medium text-foreground" data-testid="results-summary-ads-spend-value">
              {formatMinorCurrency(ads.captured_spend_minor ?? 0, adsCurrency as GenerationBudgetCurrency, locale, tContent)}
            </p>
          )
        ) : (
          <>
            <p className="text-muted-foreground" data-testid="results-summary-ads-spend-unmeasured">
              {t('reconcileVerdictUnmeasured')}
            </p>
            <Link href="/organization/channels" className="text-primary underline" data-testid="results-summary-ads-spend-cta">
              {t('resultsSummaryConnectCta')}
            </Link>
          </>
        )}
      </Card>

      {/* 남은 한도 — 같은 축(approved_boost_count) 재사용, 새 신호 불요(3977 §1). */}
      <Card className="p-3 text-xs" data-testid="results-summary-ads-remaining">
        <p className="mb-1 text-muted-foreground">{t('resultsSummaryRemainingLabel')}</p>
        {adsMeasured && ads ? (
          adsCurrencyMixed ? (
            <p className="text-muted-foreground" data-testid="results-summary-ads-remaining-mixed">{t('orgCostAdsCurrencyMixed')}</p>
          ) : (
            <p className="text-lg font-medium text-foreground" data-testid="results-summary-ads-remaining-value">
              {formatMinorCurrency(ads.remaining_minor ?? 0, adsCurrency as GenerationBudgetCurrency, locale, tContent)}
            </p>
          )
        ) : (
          <>
            <p className="text-muted-foreground" data-testid="results-summary-ads-remaining-unmeasured">
              {t('reconcileVerdictUnmeasured')}
            </p>
            <Link href="/organization/channels" className="text-primary underline" data-testid="results-summary-ads-remaining-cta">
              {t('resultsSummaryConnectCta')}
            </Link>
          </>
        )}
      </Card>
    </div>
  );
}
