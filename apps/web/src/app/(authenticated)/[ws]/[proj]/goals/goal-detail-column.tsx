'use client';

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { Chip } from '@/components/ds/chip';
import { ListRow } from '@/components/ds/list-row';
import { Metric } from '@/components/ds/metric';
import { ProgressBar } from '@/components/ds/progress-bar';
import { HypothesesSection } from '@/components/hypotheses/hypotheses-section';
import { useViewerTimeZone } from '@/components/viewer-time-zone';
import { useFlatHref } from '@/hooks/use-flat-href';
import { fetchWithAuth } from '@/lib/db/client';
import { GoalEditForm } from './goal-edit-form';
import { priorityChipTone, statusChipTone, useGoalLabels, useOutcomeChip } from './goal-list-row';
import { useGoalsRoute } from './goals-context';
import { calcSpProgress, calcStoryProgress, formatDate, type Goal, type Story } from './goal-model';

/**
 * story #4888 (UI-5, the goals screen) — the detail column of the goals list (AC3 §4-2). Wide screens: the goal chosen in the list stands here beside it; a phone still opens the goal's own page (`/goals/[id]`).
 * Same facts the old slide-in panel had (target date · target SP · description · story progress · SP progress · story list · edit), now on the shared parts (Card · Metric · ProgressBar · Chip · ListRow),
 * plus the two the card list never showed in a detail: the **result state** and the **hypotheses** of the goal (the page's own `HypothesesSection`, unchanged).
 * The column is keyed by the goal's id by its parent, so choosing another goal starts clean (no edit form or story list carried over from the one before).
 */

type StoriesState = { status: 'loading' } | { status: 'ready'; stories: Story[] } | { status: 'error' };

const STORY_STATUS_KEY: Record<string, 'backlog' | 'readyForDev' | 'inProgress' | 'inReview' | 'done'> = {
  backlog: 'backlog',
  'ready-for-dev': 'readyForDev',
  'in-progress': 'inProgress',
  'in-review': 'inReview',
  done: 'done',
};

function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="m-0 mb-2 text-ds-card-title font-semibold text-ds-ink">{children}</h3>;
}

export function GoalDetailColumn({ goal, projectId, onUpdate }: { goal: Goal; projectId: string; onUpdate: (goal: Goal) => void }) {
  const t = useTranslations('goals');
  const tBoard = useTranslations('board');
  const router = useRouter();
  const flatHref = useFlatHref();
  const { wsSlug, projSlug } = useGoalsRoute();
  const displayTimezone = useViewerTimeZone();
  const labels = useGoalLabels();
  const outcome = useOutcomeChip(goal);
  const headingId = useId();
  const [editing, setEditing] = useState(false);
  // the list response carries the story COUNTS only; the story rows (and with them the SP sums) are read once for the chosen goal
  // a goal that arrives WITH its stories (just created: BE's answer carries them) is shown from those — no second read of what was just received
  const [cameWithStories] = useState(() => !!goal.stories);
  const [storiesState, setStoriesState] = useState<StoriesState>(goal.stories ? { status: 'ready', stories: goal.stories } : { status: 'loading' });
  const goalId = goal.id;
  useEffect(() => {
    if (cameWithStories) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/goals/${goalId}`);
        if (!res.ok) throw new Error(`goal ${res.status}`);
        const { data } = await res.json() as { data?: { stories?: Story[]; project_id?: string } };
        if (cancelled) return;
        // BE answers a goal of another project with 200 too — a goal that is not this project's is never shown as this goal's stories
        if (data?.project_id && data.project_id !== projectId) { setStoriesState({ status: 'error' }); return; }
        setStoriesState({ status: 'ready', stories: data?.stories ?? [] });
      } catch {
        if (!cancelled) setStoriesState({ status: 'error' });
      }
    })();
    return () => { cancelled = true; };
  }, [goalId, projectId, cameWithStories]);

  const stories = storiesState.status === 'ready' ? storiesState.stories : [];
  const fb = calcStoryProgress(stories);
  // counts from the list's aggregates are there at once; once the rows are read they are the same numbers by the rows themselves
  const total = storiesState.status === 'ready' ? fb.total : (goal.total_stories ?? 0);
  const done = storiesState.status === 'ready' ? fb.done : (goal.done_stories ?? 0);
  const sp = calcSpProgress(stories);
  const spExceeded = typeof goal.target_sp === 'number' && goal.target_sp > 0 && sp.total > goal.target_sp;
  const storyLabel = (slug: string): string => { const key = STORY_STATUS_KEY[slug]; return key ? tBoard(key) : slug; };

  return (
    <section data-testid="goal-detail" data-goal-id={goal.id} aria-labelledby={headingId} className="flex h-full min-h-0 w-full flex-col bg-ds-background">
      <header className="flex shrink-0 items-start justify-between gap-3 border-b border-ds-line px-5 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip dot tone={statusChipTone(goal.status)}>{labels.status[goal.status]}</Chip>
            <Chip tone={priorityChipTone(goal.priority)}>{labels.priority[goal.priority]}</Chip>
            {outcome ? <Chip tone={outcome.tone}>{outcome.text}</Chip> : null}
          </div>
          <h2 id={headingId} className="m-0 mt-1.5 text-ds-title font-semibold text-ds-ink">{goal.title}</h2>
        </div>
        {!editing ? (
          <div className="flex shrink-0 items-center gap-2">
            <Button asChild variant="secondary">
              <Link href={`/${wsSlug}/${projSlug}/goals/${goal.id}`}>{t('viewFull')}</Link>
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing(true)}>{t('editGoal')}</Button>
          </div>
        ) : null}
      </header>

      <div className="focus-inset min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
        {editing ? (
          <GoalEditForm
            epic={goal}
            onSaved={(updated) => { onUpdate(updated); setEditing(false); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <Card className="grid grid-cols-2 gap-3 p-3" data-testid="goal-detail-schedule">
              <Metric label={t('targetDate')} value={formatDate(goal.target_date, displayTimezone)} />
              <Metric
                label={t('targetSp')}
                value={goal.target_sp !== undefined ? goal.target_sp : '—'}
                delta={spExceeded ? <Chip tone="failed">{t('spExceeded')}</Chip> : undefined}
              />
            </Card>

            <Card className="space-y-3 p-3" data-testid="goal-detail-progress">
              <CardTitle>{t('storiesProgress')}</CardTitle>
              {total > 0 ? (
                <ProgressBar
                  aria-label={t('storiesProgress')}
                  tone="usage"
                  value={done}
                  max={total}
                  valueText={`${done}/${total}`}
                  ariaValueText={`${t('doneStories')} ${done} / ${t('totalStories')} ${total}`}
                />
              ) : (
                <ProgressBar aria-label={t('storiesProgress')} tone="usage" value={null} max={1} unavailableLabel={t('noStories')} />
              )}
              {sp.total > 0 ? (
                <div className="space-y-1">
                  <p className="m-0 text-ds-small text-ds-ink-3">{t('spProgress')}{spExceeded ? ` · ${t('spExceededDetail', { total: sp.total, target: goal.target_sp ?? 0 })}` : ''}</p>
                  <ProgressBar
                    aria-label={t('spProgress')}
                    tone="usage"
                    value={sp.done}
                    max={sp.total}
                    valueText={`${sp.done}/${sp.total}`}
                    ariaValueText={`${t('doneSp')} ${sp.done} / ${t('totalSp')} ${sp.total}`}
                  />
                </div>
              ) : null}
              {/* the result is a second, separate signal: finishing the stories is not proving the goal */}
              {outcome ? (
                <div className="flex items-center gap-2" data-testid="goal-detail-outcome">
                  <span className="text-ds-small text-ds-ink-3">{t('outcomeLabel')}</span>
                  <Chip tone={outcome.tone}>{outcome.text}</Chip>
                </div>
              ) : null}
            </Card>

            <div data-testid="goal-detail-hypotheses">
              <HypothesesSection epicId={goal.id} projectId={projectId} />
            </div>

            <Card className="p-3" data-testid="goal-detail-description">
              <CardTitle>{t('description')}</CardTitle>
              {goal.description?.trim()
                ? <p className="m-0 whitespace-pre-wrap text-ds-body text-ds-ink">{goal.description}</p>
                : <p className="m-0 text-ds-body italic text-ds-ink-3">{t('noDescription')}</p>}
            </Card>

            <Card className="overflow-hidden" data-testid="goal-detail-stories">
              <div className="px-3 pt-3"><CardTitle>{t('stories')}</CardTitle></div>
              {storiesState.status === 'loading' ? (
                <p className="m-0 px-3 pb-3 text-ds-small text-ds-ink-3">{t('loading')}</p>
              ) : storiesState.status === 'error' ? (
                <p className="m-0 px-3 pb-3 text-ds-small text-ds-failed">{t('storiesLoadFailed')}</p>
              ) : stories.length === 0 ? (
                <p className="m-0 px-3 pb-3 text-ds-small italic text-ds-ink-3">{t('noStories')}</p>
              ) : (
                <div>
                  {stories.map((story) => (
                    // a click on the row opens the story on the board; the title is a real button so Tab reaches it and Enter does the same
                    <div key={story.id} onClick={() => router.push(flatHref(`/flow?story=${story.id}`))}>
                      <ListRow
                        density="compact"
                        className="has-[button:focus-visible]:ring-2 has-[button:focus-visible]:ring-inset has-[button:focus-visible]:ring-ds-action"
                        title={
                          <Button type="button" variant="quiet" className="h-auto max-w-full justify-start px-0 text-left text-ds-body font-normal text-ds-ink hover:bg-transparent hover:text-ds-ink focus-visible:ring-0">
                            <span className="truncate">{story.title}</span>
                          </Button>
                        }
                        trailing={
                          <>
                            {story.story_points !== undefined ? <span className="font-mono text-ds-mono-md text-ds-ink-3">{t('storyPointsShort', { count: story.story_points })}</span> : null}
                            <Chip tone="neutral">{storyLabel(story.status)}</Chip>
                          </>
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </section>
  );
}
