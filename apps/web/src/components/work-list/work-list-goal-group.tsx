'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CountBadge } from '@/components/ds/count-badge';
import { ListRow } from '@/components/ds/list-row';
import { SectionHeader } from '@/components/ds/section-header';
import { translateEntityStatus } from '@/components/chat/entity-status-labels';
import { cn } from '@/lib/utils';
import { UNASSIGNED_GOAL_ID, type WorkListGoalGroup, type WorkListRowState, type WorkListStoryGroup } from './derive-work-list';
import { WorkListRowView } from './work-list-row';

/**
 * story #4888 (UI-5, 일감 목록) — the list is built on the STORY: a goal is a section (new `SectionHeader`), a story is a row (new `ListRow`) whether or not it has been split into work, and the
 * work under it (tasks · agent runs, the rows this screen always had) stands indented below. Selecting a story opens the same detail panel the work rows open (on the story).
 */

const AWAITING_HAND: ReadonlySet<NonNullable<WorkListRowState>> = new Set(['awaiting_approval', 'awaiting_signature', 'awaiting_answer']);

function StateWord({ state }: { state: WorkListRowState }) {
  const t = useTranslations('workList');
  switch (state) {
    case 'awaiting_approval': return <span className="text-ds-small font-semibold text-ds-needs-hand">{t('stateAwaitingApproval')}</span>;
    case 'awaiting_signature': return <span className="text-ds-small font-semibold text-ds-needs-hand">{t('stateAwaitingSignature')}</span>;
    case 'awaiting_answer': return <span className="text-ds-small font-semibold text-ds-needs-hand">{t('stateAwaitingAnswer')}</span>;
    default: return null;
  }
}

function StoryRowView({ story, selectedRowId, onSelect }: { story: WorkListStoryGroup; selectedRowId: string | null; onSelect: (rowId: string) => void }) {
  const t = useTranslations('workList');
  const statusLabel = translateEntityStatus('story', story.status);
  const selected = selectedRowId === story.selfRow.id;
  const needsHand = story.selfRow.state !== null && AWAITING_HAND.has(story.selfRow.state);
  const delegated = story.rows.filter((r) => r.isDelegated).length;
  const subtitle = story.rows.length > 0 ? t('storyWorkCounts', { count: story.rows.length, delegated }) : undefined;
  const common = {
    role: 'button',
    tabIndex: 0,
    'aria-pressed': selected,
    selected,
    onClick: () => onSelect(story.selfRow.id),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(story.selfRow.id); } },
    title: story.title,
    subtitle,
    trailing: (
      <>
        <StateWord state={story.selfRow.state} />
        {statusLabel ? (
          <span className={cn('text-ds-small', story.status === 'done' ? 'font-semibold text-ds-done' : 'text-ds-ink-3')} data-testid="story-status-badge">{statusLabel}</span>
        ) : null}
      </>
    ),
  } as const;
  return (
    <div data-story-id={story.storyId}>
      {needsHand ? <ListRow {...common} needsHand needsHandLabel={t('storyNeedsHand')} /> : <ListRow {...common} />}
      {story.rows.length > 0 ? (
        <div className="ml-6 border-l border-ds-line" data-testid="story-work-rows">
          {story.rows.map((row) => (
            <WorkListRowView key={row.id} row={row} isSelected={selectedRowId === row.id} onSelect={onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function GoalGroupView({ group, selectedRowId, onSelect }: { group: WorkListGoalGroup; selectedRowId: string | null; onSelect: (rowId: string) => void }) {
  const t = useTranslations('workList');
  const [collapsed, setCollapsed] = useState(false);
  const title = group.goalId === UNASSIGNED_GOAL_ID ? t('unassignedGoalTitle') : group.title;
  return (
    <section aria-label={title} data-goal-id={group.goalId} className="overflow-hidden rounded-ds-control border border-ds-line bg-ds-surface">
      <SectionHeader
        title={title}
        level={2}
        count={<CountBadge count={group.totalCount} />}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        // 「진행 중」 only when the goal's own status is active (no invented word); the fraction counts STORIES
        trailing={`${group.isActive ? `${t('stateInProgress')} · ` : ''}${t('goalProgressLabel', { done: group.doneCount, total: group.totalCount })}`}
      />
      {collapsed ? null : (
        <>
          {group.goalId === UNASSIGNED_GOAL_ID ? <p className="m-0 px-4 pt-2 text-ds-small text-ds-ink-3">{t('unassignedGoalHint')}</p> : null}
          <p className="m-0 px-4 py-2 text-ds-small text-ds-ink-3" data-testid="goal-summary">
            {t('goalSummaryLabel', { assigned: group.assignedCount, delegated: group.delegatedCount, hypotheses: group.hypothesisCount })}
          </p>
          <div>
            {group.stories.map((story) => (
              <StoryRowView key={story.storyId} story={story} selectedRowId={selectedRowId} onSelect={onSelect} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
