'use client';

import type { CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ds/button';
import { Chip } from '@/components/ds/chip';
import { IconButton } from '@/components/ds/icon-button';
import { ListRow } from '@/components/ds/list-row';
import { ProgressBar } from '@/components/ds/progress-bar';
import { HypothesesSummary } from '@/components/hypotheses/hypotheses-summary';
import { HumanOnlyAction } from '@/components/ui/human-only-action';
import { useViewerTimeZone } from '@/components/viewer-time-zone';
import { HOVER_REVEAL } from '@/lib/hover-reveal';
import { calcSpProgress, calcStoryProgress, formatDate, outcomeLineText, type Goal, type GoalPriority, type GoalStatus } from './goal-model';

/**
 * story #4888 (UI-5, the goals screen) — one goal as a row of the list (AC3 §4-2): the title · the state and priority chips · the target date · the hypotheses summary on the left,
 * the story progress «done/total» and the result state on the right. It replaces the hand-made card (a rounded box with two progress bars, a badge cluster and a hover trash can).
 * Nothing the card did is lost: the drag handle and «curated» marker (only while the list is the whole list), the «loop suggestion» marker, the SP-over note, the human-only delete.
 *
 * Colour rules that the old card carried are kept, only on the new tokens: the state chip is never green (a finished task list is not a proved goal) — green is the result chip, and only for «hit»;
 * the story bar is the neutral/action one (`tone="usage"`), never the «complete» green.
 */

export type ChipTone = 'neutral' | 'action' | 'done' | 'failed' | 'info';

/** the state chip: «active» wears the action dot, everything else is plain — never `done` (green belongs to the result) */
export function statusChipTone(status: GoalStatus): ChipTone {
  return status === 'active' ? 'action' : 'neutral';
}

/** critical stands out (failed colour = «look here»); the other priorities are plain words */
export function priorityChipTone(priority: GoalPriority): ChipTone {
  return priority === 'critical' ? 'failed' : 'neutral';
}

/** the result chip's colour: green only when the outcome was hit; «waiting for the measure date» is the info colour; every other state is plain */
export function outcomeChipTone(tone: 'green' | 'blue' | 'neutral'): ChipTone {
  return tone === 'green' ? 'done' : tone === 'blue' ? 'info' : 'neutral';
}

export function useGoalLabels() {
  const t = useTranslations('goals');
  const status: Record<GoalStatus, string> = { draft: t('statusDraft'), active: t('statusActive'), done: t('statusDone'), archived: t('statusArchived') };
  const priority: Record<GoalPriority, string> = { critical: t('priorityCritical'), high: t('priorityHigh'), medium: t('priorityMedium'), low: t('priorityLow') };
  return { status, priority };
}

/** the goal's result as a chip — or null while the goal has no result state to say (`n_a`) */
export function useOutcomeChip(goal: Pick<Goal, 'outcome_status' | 'measure_after'>): { text: string; tone: ChipTone } | null {
  const t = useTranslations('goals');
  const tOutcome = useTranslations('outcomeLoop');
  const displayTimezone = useViewerTimeZone();
  if (goal.outcome_status === 'n_a') return null;
  const line = outcomeLineText(t, tOutcome, goal.outcome_status, goal.measure_after, displayTimezone);
  return { text: line.text, tone: outcomeChipTone(line.tone) };
}

interface GoalListRowProps {
  goal: Goal;
  selected: boolean;
  /** a click anywhere on the row (a click on the row's own button does not select twice) */
  onSelect: (goal: Goal) => void;
  onDeleteRequest: (id: string) => void;
  /** only while the list is the whole list: the drag handle and the «curated» marker show */
  sortable: boolean;
}

export function GoalListRow({ goal, selected, onSelect, onDeleteRequest, sortable }: GoalListRowProps) {
  const t = useTranslations('goals');
  const displayTimezone = useViewerTimeZone();
  const labels = useGoalLabels();
  const outcome = useOutcomeChip(goal);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: goal.id, disabled: !sortable });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition, ...(isDragging ? { zIndex: 20, opacity: 0.9 } : {}) };
  const curated = typeof goal.position === 'number';
  // BE's per-goal counts (the list response carries no stories) come first; a goal that came with its stories (just created / just edited) falls back to counting them
  const stories = goal.stories ?? [];
  const fb = calcStoryProgress(stories);
  const total = goal.total_stories ?? fb.total;
  const done = goal.done_stories ?? fb.done;
  const sp = calcSpProgress(stories);
  const spExceeded = typeof goal.target_sp === 'number' && goal.target_sp > 0 && sp.total > goal.target_sp;

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="goal-row"
      data-row-key={goal.id}
      className={`group relative ${isDragging ? 'shadow-[var(--elev-overlay)]' : ''}`}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('a, [data-row-stop]')) onSelect(goal); }}
    >
      <ListRow
        selected={selected}
        className="items-start py-2.5 has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-inset has-[button:focus-visible]:ring-ds-action"
        leading={sortable ? (
          // the grip: pointer-only dragging (the sensor ignores touch) — it keeps its name so a screen reader still finds what it is
          <IconButton
            data-row-stop
            label={t('steerReorderAria', { title: goal.title })}
            icon="drag_indicator"
            className="-ml-2 cursor-grab active:cursor-grabbing"
            {...attributes}
            {...listeners}
          />
        ) : undefined}
        title={
          // the title is a real button: Tab reaches it, Enter selects (the same as a click on the row)
          <Button
            type="button"
            variant="quiet"
            data-row-focus
            className="h-auto max-w-full justify-start px-0 text-left text-ds-body font-semibold text-ds-ink hover:bg-transparent hover:text-ds-ink focus-visible:ring-0"
          >
            <span className="truncate">{goal.title}</span>
          </Button>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-sans">
            <Chip dot tone={statusChipTone(goal.status)}>{labels.status[goal.status]}</Chip>
            <Chip tone={priorityChipTone(goal.priority)}>{labels.priority[goal.priority]}</Chip>
            {sortable ? (curated
              ? <Chip tone="neutral">{t('steerCurated')} {goal.position}</Chip>
              : <span className="text-ds-small text-ds-ink-3">{t('steerAuto')}</span>) : null}
            {goal.source_loop_id ? <Chip tone="info">{t('steerLoopSuggest')}</Chip> : null}
            {goal.target_date ? <span className="font-mono text-ds-mono-md text-ds-ink-3">{t('targetDate')} {formatDate(goal.target_date, displayTimezone)}</span> : null}
            <HypothesesSummary count={goal.hypothesis_count ?? 0} riskyStatus={goal.risky_status ?? null} className="text-ds-small" />
            {spExceeded ? <Chip tone="failed">{t('spExceeded')}</Chip> : null}
          </span>
        }
        trailing={
          <div className="flex items-start gap-1">
            <div className="flex w-28 flex-col items-end gap-1 sm:w-36">
              {total > 0 ? (
                <ProgressBar
                  className="w-full"
                  aria-label={t('taskLabel')}
                  tone="usage"
                  value={done}
                  max={total}
                  valueText={`${done}/${total}`}
                  ariaValueText={`${t('doneStories')} ${done} / ${t('totalStories')} ${total}`}
                />
              ) : (
                <ProgressBar className="w-full" aria-label={t('taskLabel')} tone="usage" value={null} max={1} unavailableLabel={t('noStories')} />
              )}
              {outcome ? <Chip tone={outcome.tone}>{outcome.text}</Chip> : null}
            </div>
            {/* BE rejects a delete from a non-human (403), so an agent never gets the trigger. A mouse sees it on hover / focus; a touch screen always sees it */}
            <HumanOnlyAction>
              <IconButton
                data-row-stop
                label={t('deleteGoal')}
                icon="delete"
                className={`-my-1 hover:text-ds-failed ${HOVER_REVEAL}`}
                onClick={() => onDeleteRequest(goal.id)}
              />
            </HumanOnlyAction>
          </div>
        }
      />
    </div>
  );
}
