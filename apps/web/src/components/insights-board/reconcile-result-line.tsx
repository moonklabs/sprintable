import { useTranslations } from 'next-intl';

/**
 * story #3620 AC3 — 성과 보드 행 액션 「원본과 대조」의 결과 한 줄(행 아래). 라벨은
 * insight-snapshot-block.tsx(story #3499)의 METRIC_LABEL_KEYS와 같은 content 네임
 * 스페이스 키를 재사용(새 라벨 0) — 판정 3값(match/mismatch/unmeasured)만 이 스토리
 * 전용 insightsBoard 키.
 */
const METRIC_ORDER = ['impressions', 'reach', 'views', 'engagements', 'clicks', 'spend', 'conversions'] as const;

const METRIC_LABEL_KEYS: Record<(typeof METRIC_ORDER)[number], string> = {
  impressions: 'insightMetricImpressions',
  reach: 'insightMetricReach',
  views: 'insightMetricViews',
  engagements: 'insightMetricEngagements',
  clicks: 'insightMetricClicks',
  spend: 'insightMetricSpend',
  conversions: 'insightMetricConversions',
};

const VERDICT_LABEL_KEYS: Record<string, string> = {
  match: 'reconcileVerdictMatch',
  mismatch: 'reconcileVerdictMismatch',
  unmeasured: 'reconcileVerdictUnmeasured',
};

export function ReconcileResultLine({ verdicts }: { verdicts: Record<string, string> }) {
  const t = useTranslations('insightsBoard');
  const tContent = useTranslations('content');

  const parts = METRIC_ORDER.filter((key) => key in verdicts).map((key) => {
    const verdict = verdicts[key];
    const verdictLabelKey = verdict ? VERDICT_LABEL_KEYS[verdict] : undefined;
    return `${tContent(METRIC_LABEL_KEYS[key])} ${verdictLabelKey ? t(verdictLabelKey) : verdict}`;
  });

  return <span data-testid="reconcile-result-line">{parts.join(' · ')}</span>;
}
