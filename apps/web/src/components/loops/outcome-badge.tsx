import { useTranslations } from 'next-intl';
import { Chip } from '@/components/ds/chip';

/**
 * E-LOOP-LEDGER S9 — closed loop 성과 칩(4911에서 ds Chip으로). hypothesis-status-badge.tsx의 soul-lock과 동일 원칙:
 * falsified(miss)에 빨강(failed)을 쓰지 않는다 — 반증/미스에 빨강을 쓰면 사람이 정직한 라벨링(반려 이유 등)을 회피해 복리 학습 신호가 죽는다. hit = done(끝남 · 녹) · miss = info(청).
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
    return <Chip tone="done" icon="check" data-outcome="hit" className={className}>{t('outcomeHit')}</Chip>;
  }
  return <Chip tone="info" data-outcome="miss" className={className}>{t('outcomeMiss')}</Chip>;
}
