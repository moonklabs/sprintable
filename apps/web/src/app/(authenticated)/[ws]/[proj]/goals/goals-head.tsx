'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import type { GoalStatus } from './goal-model';

/**
 * story #4888 (UI-5, the goals screen) — the head of the goals screen as ONE block (AC3 §4-2): the title with the two counts beside it, and under it one line of controls — the view switch
 * («보기: 목록 | 스윔레인») and, in the list view, the state filter. It replaces the editorial masthead (a kicker, a display-size title, a rule, a sentence) + the view-switch row + the filter row,
 * which together stood three layers tall before the first goal. Wide screens put the controls on the title's line; a phone gets them as one line under it that swipes sideways instead of wrapping.
 */

export type GoalsView = 'list' | 'swimlane';
export type GoalsFilter = GoalStatus | 'all';

function FilterButton({ value, current, onPick, children }: { value: GoalsFilter; current: GoalsFilter; onPick: (next: GoalsFilter) => void; children: string }) {
  return (
    <Button type="button" variant={current === value ? 'secondary' : 'quiet'} aria-pressed={current === value} onClick={() => onPick(value)}>
      {children}
    </Button>
  );
}

export function GoalsHead({
  view,
  onViewChange,
  counts,
  filter,
  onFilterChange,
}: {
  view: GoalsView;
  onViewChange: (next: GoalsView) => void;
  /** the two numbers by the title — absent until this project's list has been read (a 0 · 0 that was never counted must not look exact) */
  counts: { active: number; done: number } | null;
  /** the state filter (list view only) */
  filter?: GoalsFilter;
  onFilterChange?: (next: GoalsFilter) => void;
}) {
  const t = useTranslations('goals');
  return (
    <div data-testid="goals-head" className="shrink-0 border-b border-ds-line px-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 py-2 lg:flex-nowrap">
        <div className="flex items-baseline gap-3">
          <h1 className="m-0 text-ds-title font-semibold text-ds-ink">{t('title')}</h1>
          {counts ? <span className="font-sans text-ds-mono-md tabular-nums text-ds-ink-3">{t('indexCountActive', { count: counts.active })} · {t('indexCountDone', { count: counts.done })}</span> : null}
        </div>
        <div
          data-testid="goals-head-controls"
          className="focus-inset flex min-h-11 w-full min-w-0 flex-nowrap items-center gap-2 overflow-x-auto lg:ml-auto lg:min-h-0 lg:w-auto lg:flex-wrap lg:overflow-visible"
        >
          <div className="flex shrink-0 items-center gap-1" role="group" aria-label={t('viewLabel')} data-testid="goals-view-switch">
            <span className="text-ds-small text-ds-ink-3">{t('viewLabel')}</span>
            <Button type="button" variant={view === 'list' ? 'secondary' : 'quiet'} aria-pressed={view === 'list'} onClick={() => onViewChange('list')}>
              {t('viewList')}
            </Button>
            <Button type="button" variant={view === 'swimlane' ? 'secondary' : 'quiet'} aria-pressed={view === 'swimlane'} onClick={() => onViewChange('swimlane')}>
              {t('viewSwimlane')}
            </Button>
          </div>
          {view === 'list' && filter !== undefined && onFilterChange ? (
            <>
              <div className="h-5 w-px shrink-0 bg-ds-line" aria-hidden="true" />
              {/* story #2017: 'all' 아닌 나머지는 배지 · 드롭다운이 쓰는 기존 statusXxx 키를 그대로 쓴다(신규 키 0) · story #4388: 고른 것은 눌린 상태로 알린다 */}
              <div className="flex shrink-0 items-center gap-1" data-testid="goals-status-filter">
                <FilterButton value="all" current={filter} onPick={onFilterChange}>{t('filterAll')}</FilterButton>
                <FilterButton value="draft" current={filter} onPick={onFilterChange}>{t('statusDraft')}</FilterButton>
                <FilterButton value="active" current={filter} onPick={onFilterChange}>{t('statusActive')}</FilterButton>
                <FilterButton value="done" current={filter} onPick={onFilterChange}>{t('statusDone')}</FilterButton>
                <FilterButton value="archived" current={filter} onPick={onFilterChange}>{t('statusArchived')}</FilterButton>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
