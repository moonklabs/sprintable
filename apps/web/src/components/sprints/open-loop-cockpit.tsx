'use client';

import { useTranslations } from 'next-intl';
import { Card } from '@/components/ds/card';
import { Chip } from '@/components/ds/chip';
import { cn } from '@/lib/utils';
import type { RetroHypothesisResult as SprintHypothesisResult } from '@/services/retro-session';

// story fbf1c14b: GET /{id}/hypotheses는 이 status 전체(HYPOTHESIS_STATUSES, backend
// app/models/hypothesis.py)를 정직하게 그대로 반환한다 — sprint-open 직후 선언된 가설은
// proposed/active가 정상 케이스라 verdict 4종만으로는 VERDICT_KEY[status]가 undefined였다.
// 까심 QA 정정(2026-07-03): tr(undefined)는 크래시가 아니라 next-intl이 graceful하게
// 흡수해 잘못된 폴백 텍스트를 냈던 것(SOUL 정직 원칙: BE가 measuring으로 강제 coercion하는
// 대안은 기각 — PO crux 확인).
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
            // story #4888 — 손 카드(rounded-lg border bg-card) → ds Card(측정 중은 점선), 판정 배지 → ds Chip(SOUL-LOCK: 검증됨만 done 색, 반증 · 폐기는 실패색을 입히지 않는 중립), 지표 · 실험 → ds Chip.
            <Card key={h.id} className={cn('p-2.5', isMeasuring && 'border-dashed')}>
              <div className="flex items-start justify-between gap-2">
                <p className="flex-1 text-ds-small font-medium leading-snug text-ds-ink">{h.statement}</p>
                <Chip tone={h.status === 'verified' ? 'done' : 'neutral'} className={isMeasuring ? 'border-dashed' : undefined}>
                  {tr(VERDICT_KEY[h.status])}
                </Chip>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-ds-small text-ds-ink-3">
                {h.metric ? <Chip>{h.metric}</Chip> : null}
                {remaining != null ? (
                  <span className="flex items-center gap-1">
                    <span className="size-1.5 rounded-full border border-dashed border-ds-ink-3" aria-hidden />
                    {remaining > 0 ? t('cockpitMeasureCountdown', { days: remaining }) : t('cockpitMeasureOverdue')}
                  </span>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>
      {storyTitles.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-ds-small font-semibold text-ds-ink-3">{t('cockpitExperimentsLabel')}</span>
          {storyTitles.map((title) => (
            <Chip key={title} className="max-w-full overflow-hidden text-ellipsis">{title}</Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}
