'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { PaidSpendDailySeriesCard } from './paid-spend-daily-series-card';

/**
 * story #3979(자리 옮김 ②, 유나 diff doc «v3 자리») — 일별 광고비 지출 막대
 * (PaidSpendDailySeriesCard, 기존 그대로·삭제 0)를 「광고 상한」 카드 펼침 안으로.
 * 기본 접힘 — 첫 화면은 결정에 필요한 수만(요약 카드), 상세는 펼쳐야 보인다.
 */
export function AdsCapCard({ orgId }: { orgId: string }) {
  const t = useTranslations('insightsBoard');
  const [expanded, setExpanded] = useState(false);

  return (
    <Card className="p-3 text-xs" data-testid="ads-cap-card">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between text-left font-medium text-foreground"
        aria-expanded={expanded}
        data-testid="ads-cap-card-toggle"
      >
        <span>{t('adsCapCardTitle')}</span>
        <span className="text-muted-foreground">{expanded ? t('sectionCollapse') : t('sectionExpand')}</span>
      </button>
      {expanded ? (
        <div className="mt-3" data-testid="ads-cap-card-body">
          <PaidSpendDailySeriesCard orgId={orgId} />
        </div>
      ) : null}
    </Card>
  );
}
