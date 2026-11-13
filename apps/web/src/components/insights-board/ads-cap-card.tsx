'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ds/card';
import { Button } from '@/components/ds/button';
import { PaidSpendDailySeriesCard } from './paid-spend-daily-series-card';
import { OrgCostSummaryCard, type OrgCostSummaryLoadState } from './org-cost-summary-card';

/**
 * story #3979(자리 옮김 ②, 유나 diff doc «v3 자리») — 일별 광고비 지출 막대
 * (PaidSpendDailySeriesCard, 기존 그대로·삭제 0)를 「광고 상한」 카드 펼침 안으로.
 * 기본 접힘 — 첫 화면은 결정에 필요한 수만(요약 카드), 상세는 펼쳐야 보인다.
 *
 * story #3979 CHANGES(페드루 PO 2026-09-17 01:14Z) — OrgCostSummaryCard(조직 비용
 * 원장, 「조직 비용 요약」 텍스트 블록)도 이 카드 펼침 안(차트 위)으로 옮긴다.
 * cost-summary는 페이지가 1회만 불러(costSummaryState) 내려주고, OrgCostSummaryCard
 * 는 preloadedState로 받아 자체 fetch를 안 한다(AC3 ≤2콜). 접힌 머리에도 「상한
 * 도달 N건」(기존 키 orgCostAdsCapReachedNonzero)만 미리 보인다 — 펼치지 않아도
 * 그 사실은 안다.
 */
export interface AdsCapCardProps {
  orgId: string;
  costSummaryState: OrgCostSummaryLoadState;
}

export function AdsCapCard({ orgId, costSummaryState }: AdsCapCardProps) {
  const t = useTranslations('insightsBoard');
  const [expanded, setExpanded] = useState(false);

  const capReachedCount = costSummaryState.status === 'ok' && costSummaryState.summary.ads.cap_reached_count > 0
    ? costSummaryState.summary.ads.cap_reached_count
    : null;

  return (
    <Card className="p-3 text-ds-small" data-testid="ads-cap-card">
      <Button
        type="button"
        variant="quiet"
        onClick={() => setExpanded((v) => !v)}
        className="h-auto min-h-0 w-full justify-between p-0 text-left text-ds-small font-medium text-ds-ink whitespace-normal"
        aria-expanded={expanded}
        data-testid="ads-cap-card-toggle"
      >
        <span>
          {t('adsCapCardTitle')}
          {capReachedCount !== null ? (
            <span className="ml-1.5 font-normal text-ds-ink-3" data-testid="ads-cap-card-reached-count">
              · {t('orgCostAdsCapReachedNonzero', { count: capReachedCount })}
            </span>
          ) : null}
        </span>
        <span className="text-ds-ink-3">{expanded ? t('sectionCollapse') : t('sectionExpand')}</span>
      </Button>
      {expanded ? (
        <div className="mt-3 space-y-3" data-testid="ads-cap-card-body">
          <OrgCostSummaryCard orgId={orgId} preloadedState={costSummaryState} />
          <PaidSpendDailySeriesCard orgId={orgId} />
        </div>
      ) : null}
    </Card>
  );
}
