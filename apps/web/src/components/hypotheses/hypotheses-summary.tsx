import { useTranslations } from 'next-intl';
import { FlaskConical } from 'lucide-react';
import { HYPOTHESIS_STATUSES, type HypothesisStatus } from '@sprintable/core-storage';
import { cn } from '@/lib/utils';
import { HypothesisStatusBadge } from './hypothesis-status-badge';

/**
 * Epic-list 카드 연결 가설 요약(E1-S8b · BE #1453 부착분 소비).
 *
 * BE `EpicResponse.hypothesis_count`(연결 수) + `risky_status`(최위험 1개 ·
 * ordering falsified>measuring>active>proposed>verified>killed>archived ·
 * 링크 0건이면 count 0/risky null)를 카드 메타에 노출한다. **0건은 미표시**(AC).
 * risky_status가 알 수 없는 값이면 배지만 graceful 생략(count는 표시).
 */
export function HypothesesSummary({
  count,
  riskyStatus,
  className,
}: {
  count: number;
  riskyStatus: string | null;
  className?: string;
}) {
  const t = useTranslations('hypotheses');
  if (!count || count <= 0) return null;

  const known = (HYPOTHESIS_STATUSES as readonly string[]).includes(riskyStatus ?? '');

  return (
    <span
      className={cn('inline-flex items-center gap-1.5', className)}
      title={t('summaryTitle', { count })}
    >
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <FlaskConical className="size-3.5" aria-hidden />
        {count}
      </span>
      {known ? <HypothesisStatusBadge status={riskyStatus as HypothesisStatus} /> : null}
    </span>
  );
}
