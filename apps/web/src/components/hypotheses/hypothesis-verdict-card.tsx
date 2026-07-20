'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import type { Hypothesis } from '@sprintable/core-storage';

/**
 * Verdict card — the soul surface (E1-S8 §4.3). Rendered instead of a row when a
 * hypothesis is verified/falsified. Inherits the OutcomeResultCard "Ledger" delta
 * readout and raises it: the verdict tile should be the brightest thing on screen.
 *
 * Soul lock (§2 · PO §12.1): verified=success(녹) / falsified=info(청), SAME card
 * structure/size (equal hierarchy — Ledger). 반증은 실패가 아니라 정직한 지식이라
 * falsified에 destructive(빨강)를 쓰지 않는다.
 */
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function HypothesisVerdictCard({
  hypothesis,
  resolveName,
}: {
  hypothesis: Hypothesis;
  /** story #2036 AC3 — closed_by_member_id → 표시 이름. 없으면 id 그대로 폴백. */
  resolveName?: (id: string) => string;
}) {
  const t = useTranslations('hypotheses');
  const isVerified = hypothesis.status === 'verified';
  const result = (hypothesis.outcome_result ?? null) as
    | {
        metric?: string;
        target?: number;
        actual?: number;
        direction?: 'up' | 'down';
        scored_at?: string;
        reason?: string;
        closed_by?: 'human';
        closed_by_member_id?: string;
      }
    | null;
  // story #2036 AC3 — 사람이 닫았으면 closed_by='human'이 outcome_result에 실린다(BE 컬럼
  // 없음·JSONB 자체 적재). 없으면 cron 자동 채점(hypothesis_scorer.py)이 닫은 것.
  const closedByLabel = result?.closed_by === 'human'
    ? t('closedByHuman', { name: result.closed_by_member_id ? (resolveName?.(result.closed_by_member_id) ?? result.closed_by_member_id) : t('owner') })
    : result?.scored_at ? t('closedByAuto') : null;

  return (
    <div
      role="group"
      className={cn(
        'rounded-2xl border p-4 animate-in fade-in duration-500',
        isVerified ? 'border-success-border bg-success-tint' : 'border-info-border bg-info-tint',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={cn('flex items-center gap-1.5 text-sm font-semibold', isVerified ? 'text-success' : 'text-info')}>
          <span aria-hidden>{isVerified ? '✓' : '⊘'}</span>
          {isVerified ? t('statusVerified') : t('statusFalsified')}
        </span>
        {result?.scored_at ? (
          <span className="text-[11px] text-muted-foreground">{t('scoredOn', { date: result.scored_at.slice(0, 10) })}</span>
        ) : null}
      </div>

      <p className="mt-3 text-sm leading-6 text-foreground">{hypothesis.statement}</p>

      {result && typeof result.target === 'number' && typeof result.actual === 'number' ? (
        <>
          <div className="mt-4 flex items-baseline justify-between gap-3 text-sm">
            <span className="tabular-nums text-muted-foreground">
              {t('target')} {result.direction === 'down' ? '≤' : '≥'} {fmt(result.target)}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {t('actual')}{' '}
              <span className={cn('font-semibold', isVerified ? 'text-success' : 'text-foreground')}>{fmt(result.actual)}</span>
            </span>
          </div>
          <DeltaTrack target={result.target} actual={result.actual} isVerified={isVerified} />
        </>
      ) : null}

      {result?.reason ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">&ldquo;{result.reason}&rdquo;</p>
      ) : null}
      {closedByLabel ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">{closedByLabel}</p>
      ) : null}
    </div>
  );
}

/** 델타 트랙 — 임계값 틱 + 실제 마커 (Ledger 계승, §2 시그니처). */
function DeltaTrack({ target, actual, isVerified }: { target: number; actual: number; isVerified: boolean }) {
  const scale = Math.max(Math.abs(target), Math.abs(actual), 1);
  const offset = Math.max(-42, Math.min(42, ((actual - target) / scale) * 42));
  return (
    <div className="mt-3" aria-hidden>
      <div className="relative h-px w-full bg-border">
        <span className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-muted-foreground/60" style={{ left: '50%' }} />
        <span
          className={cn(
            'absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background',
            'animate-in fade-in slide-in-from-left-1 duration-700',
            isVerified ? 'bg-success' : 'bg-info',
          )}
          style={{ left: `${50 + offset}%` }}
        />
      </div>
    </div>
  );
}
