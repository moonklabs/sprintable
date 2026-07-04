'use client';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { OutcomeResult } from '@sprintable/core-storage';
import { OutcomeStatusBadge, type OutcomeStatus } from './outcome-status-badge';

export type { OutcomeResult };
interface Props { status: OutcomeStatus; hypothesis?: string | null; result?: OutcomeResult | null; pendingMetricLabel?: string; }
export const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function OutcomeResultCard({ status, hypothesis, result, pendingMetricLabel }: Props) {
  const t = useTranslations('outcomeLoop');
  if (status === 'n_a') return null;
  const isHit = status === 'hit', isMiss = status === 'miss', isPending = status === 'pending';
  const metricLabel = result ? t(`metric_${result.metric}` as 'metric_velocity') : (pendingMetricLabel ?? '');
  return (
    <div className={cn('rounded-2xl border p-4 animate-in fade-in duration-500',
      isHit && 'border-success-border bg-success-tint',
      isMiss && 'border-border bg-muted/40',
      isPending && 'border-dashed border-border bg-muted/20')}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('resultLabel')}</span>
        <OutcomeStatusBadge status={status} />
      </div>
      {hypothesis ? (
        <div className="mt-3">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('hypothesisLabel')}</span>
          <p className="mt-0.5 text-sm leading-6 text-foreground">{hypothesis}</p>
        </div>) : null}
      {isPending ? (
        <p className="mt-3 text-sm text-muted-foreground">{t('pendingNote')}</p>
      ) : result ? (<>
        <div className="mt-4 flex items-baseline justify-between gap-3 text-sm">
          <span className="font-medium text-foreground">{metricLabel}</span>
          <span className="tabular-nums text-muted-foreground">
            {t('target')} {result.direction === 'up' ? '≥' : '≤'} {fmt(result.target)}
            <span className="mx-1.5 text-border">·</span>
            {t('actual')} <span className={cn('font-semibold', isHit ? 'text-success' : 'text-foreground')}>{fmt(result.actual)}</span>
          </span>
        </div>
        <DeltaTrack target={result.target} actual={result.actual} isHit={isHit} targetLabel={t('target')} />
        <p className="mt-3 text-[11px] text-muted-foreground">
          {result.scored_at.slice(0, 10)} {t('scoredSuffix')}<span className="mx-1.5 text-border">·</span>{t('forwardNote')}
        </p>
      </>) : null}
    </div>
  );
}

export function DeltaTrack({ target, actual, isHit, targetLabel }: { target: number; actual: number; isHit: boolean; targetLabel: string }) {
  const scale = Math.max(Math.abs(target), Math.abs(actual), 1);
  const offset = Math.max(-42, Math.min(42, ((actual - target) / scale) * 42));
  return (
    <div className="mt-3" aria-hidden>
      <div className="relative h-px w-full bg-border">
        <span className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-muted-foreground/60" style={{ left: '50%' }} />
        <span className={cn('absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background animate-in fade-in slide-in-from-left-1 duration-700', isHit ? 'bg-success' : 'bg-foreground')}
          style={{ left: `${50 + offset}%` }} />
      </div>
      <div className="mt-1 text-center text-[10px] text-muted-foreground">{targetLabel}</div>
    </div>
  );
}
