import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * E-LOOP-LEDGER S9 — closed loop 성과 배지. hypothesis-status-badge.tsx의 soul-lock과 동일 원칙:
 * falsified(miss)에 destructive(빨강)를 쓰지 않는다 — 반증/미스에 빨강을 쓰면 사람이 정직한
 * 라벨링(반려 이유 등)을 회피해 복리 학습 신호가 죽는다. hit=success(녹)·miss=info(청).
 */
export function OutcomeBadge({
  hypothesisStatus,
  className,
}: {
  hypothesisStatus: 'verified' | 'falsified';
  className?: string;
}) {
  const t = useTranslations('loops');
  if (hypothesisStatus === 'verified') {
    return <Badge variant="success" className={cn('font-semibold', className)}>{t('outcomeHit')}</Badge>;
  }
  return <Badge variant="info" className={cn('font-semibold', className)}>{t('outcomeMiss')}</Badge>;
}
