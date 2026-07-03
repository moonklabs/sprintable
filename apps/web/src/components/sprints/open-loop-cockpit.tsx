'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { RetroHypothesisResult as SprintHypothesisResult } from '@/services/retro-session';

// story fbf1c14b: GET /{id}/hypotheses는 이 status 전체(HYPOTHESIS_STATUSES, backend
// app/models/hypothesis.py)를 정직하게 그대로 반환한다 — sprint-open 직후 선언된 가설은
// proposed/active가 정상 케이스라 verdict 4종만으로는 tr(undefined) 크래시(PO crux 확인·
// SOUL 정직 원칙: BE가 measuring으로 강제 coercion하는 대안은 기각).
const VERDICT_KEY = {
  verified: 'hVerdictVerified',
  falsified: 'hVerdictFalsified',
  measuring: 'hVerdictMeasuring',
  killed: 'hVerdictKilled',
  proposed: 'hVerdictProposed',
  active: 'hVerdictActive',
  archived: 'hVerdictArchived',
} as const;

function daysUntil(dateIso: string): number | null {
  const target = Date.parse(dateIso);
  if (Number.isNaN(target)) return null;
  return Math.ceil((target - Date.now()) / 86_400_000);
}

/**
 * E-SPRINT-LOOP FE(278314e9) — sprint 상세 loop cockpit 최소(핸드오프 §10 P0). 종료(회고) cockpit
 * `1b9f4ecb`과 대칭 카드 어휘 — "검증 중인 가설" N + 지표 라인 + 진행 신호(D-카운트) + 실험(연결
 * 스토리) 칩. 번다운/체크인 확장은 후속 스코프(핸드오프 §4④ 규율).
 */
export function OpenLoopCockpit({
  hypotheses,
  storyTitles,
}: {
  hypotheses: SprintHypothesisResult[];
  storyTitles: string[];
}) {
  const t = useTranslations('sprints');
  const tr = useTranslations('retro');

  if (hypotheses.length === 0) return null;

  return (
    <div className="mb-4 space-y-2.5">
      <p className="text-xs font-medium text-muted-foreground">{t('cockpitHypothesesTitle', { count: hypotheses.length })}</p>
      <div className="space-y-2">
        {hypotheses.map((h) => {
          const remaining = h.measure_after ? daysUntil(h.measure_after) : null;
          const isMeasuring = h.status === 'measuring';
          return (
            <div key={h.id} className={cn('rounded-lg border border-border bg-card p-2.5', isMeasuring && 'border-dashed')}>
              <div className="flex items-start justify-between gap-2">
                <p className="flex-1 text-xs font-medium leading-snug text-foreground">{h.statement}</p>
                <Badge variant={h.status === 'verified' ? 'success' : isMeasuring ? 'outline' : 'chip'} className={isMeasuring ? 'border-dashed text-[9.5px]' : 'text-[9.5px]'}>
                  {tr(VERDICT_KEY[h.status])}
                </Badge>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
                {h.metric ? <span className="rounded bg-muted/50 px-1.5 py-0.5 font-medium text-foreground">{h.metric}</span> : null}
                {remaining != null ? (
                  <span className="flex items-center gap-1">
                    <span className="size-1.5 rounded-full border border-dashed border-muted-foreground" aria-hidden />
                    {remaining > 0 ? t('cockpitMeasureCountdown', { days: remaining }) : t('cockpitMeasureOverdue')}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {storyTitles.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{t('cockpitExperimentsLabel')}</span>
          {storyTitles.map((title) => (
            <span key={title} className="rounded-md border border-border bg-background px-1.5 py-0.5 text-[9.5px] text-muted-foreground">{title}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
