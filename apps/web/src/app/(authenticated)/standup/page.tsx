'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { OperatorInput, OperatorTextarea } from '@/components/ui/operator-control';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { formatSeoulDate } from '@/lib/date';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import {
  StandupReviewCard,
  type StandupEntrySummary,
  type StandupFeedbackSummary,
  type StandupMemberSummary,
  type StandupReviewType,
  type StandupStorySummary,
} from '@/components/standup/standup-review-card';

interface StandupSprintSummary {
  id: string;
  title: string;
  status: 'planning' | 'active' | 'closed';
  start_date: string | null;
  end_date: string | null;
}

interface StandupEntryRow extends StandupEntrySummary {
  sprint_id: string | null;
  created_at?: string;
  updated_at?: string;
}

interface StandupMemberRow extends StandupMemberSummary {
  role?: string;
}

type StandupFeedbackRow = StandupFeedbackSummary;

interface StandupStoryRow {
  id: string;
  title: string;
  status: string;
  assignee_id: string | null;
}

interface StandupTaskRow {
  id: string;
  title: string;
  status: 'todo' | 'in-progress' | 'done';
}

interface StandupTaskProgress {
  taskCount: number;
  doneTaskCount: number;
}

async function readJsonDataOrThrow<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`Failed to load ${label}`);
  }

  const json = await response.json().catch(() => null);
  if (!json || !('data' in json)) {
    throw new Error(`Failed to load ${label}`);
  }

  return json.data as T;
}

function buildStorySummary(
  story: StandupStoryRow,
  progress: StandupTaskProgress,
  memberNameById: Record<string, string>,
): StandupStorySummary {
  return {
    id: story.id,
    title: story.title,
    status: story.status,
    assignee_id: story.assignee_id,
    assignee_name: story.assignee_id ? memberNameById[story.assignee_id] ?? null : null,
    task_count: progress.taskCount,
    done_task_count: progress.doneTaskCount,
  };
}

export default function StandupPage() {
  const t = useTranslations('standup');
  const tc = useTranslations('common');
  const shellT = useTranslations('shell');
  const { currentTeamMemberId, projectId } = useDashboardContext();

  const [date, setDate] = useState(() => formatSeoulDate());
  const [entries, setEntries] = useState<StandupEntryRow[]>([]);
  const [members, setMembers] = useState<StandupMemberRow[]>([]);
  const [feedback, setFeedback] = useState<StandupFeedbackRow[]>([]);
  const [activeSprint, setActiveSprint] = useState<StandupSprintSummary | null>(null);
  const [stories, setStories] = useState<StandupStorySummary[]>([]);
  const [done, setDone] = useState('');
  const [plan, setPlan] = useState('');
  const [blockers, setBlockers] = useState('');
  const [planStoryIds, setPlanStoryIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [storiesNextCursor, setStoriesNextCursor] = useState<string | null>(null);
  const [loadingMoreStories, setLoadingMoreStories] = useState(false);

  const memberNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const member of members) map[member.id] = member.name;
    return map;
  }, [members]);

  const entryByAuthorId = useMemo(() => {
    const map: Record<string, StandupEntryRow> = {};
    for (const entry of entries) map[entry.author_id] = entry;
    return map;
  }, [entries]);

  const feedbackByEntryId = useMemo(() => {
    const map: Record<string, StandupFeedbackRow[]> = {};
    for (const item of feedback) {
      if (!map[item.standup_entry_id]) map[item.standup_entry_id] = [];
      map[item.standup_entry_id].push(item);
    }
    return map;
  }, [feedback]);

  const humanMembers = useMemo(() => members.filter((member) => member.type === 'human'), [members]);
  const agentMembers = useMemo(() => members.filter((member) => member.type === 'agent'), [members]);
  const totalTasks = useMemo(() => stories.reduce((sum, story) => sum + story.task_count, 0), [stories]);
  const doneTasks = useMemo(() => stories.reduce((sum, story) => sum + story.done_task_count, 0), [stories]);
  const currentEntry = currentTeamMemberId ? entryByAuthorId[currentTeamMemberId] : undefined;
  const storyPickerStories = useMemo(() => stories.slice().sort((left, right) => {
    const leftPriority = left.assignee_id === currentTeamMemberId ? 0 : 1;
    const rightPriority = right.assignee_id === currentTeamMemberId ? 0 : 1;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return left.title.localeCompare(right.title);
  }), [stories, currentTeamMemberId]);

  useEffect(() => {
    setDone(currentEntry?.done ?? '');
    setPlan(currentEntry?.plan ?? '');
    setBlockers(currentEntry?.blockers ?? '');
    setPlanStoryIds(currentEntry?.plan_story_ids ?? []);
  }, [currentEntry?.id, currentEntry?.updated_at]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!projectId) {
        if (!cancelled) {
          setEntries([]);
          setMembers([]);
          setFeedback([]);
          setActiveSprint(null);
          setStories([]);
          setLoadError(null);
          setSaveError(null);
          setLoading(false);
        }
        return;
      }

      if (!cancelled) {
        setLoading(true);
        setLoadError(null);
        setSaveError(null);
      }

      try {
        const [entriesRes, membersRes, sprintsRes, feedbackRes] = await Promise.all([
          fetch(`/api/standup?project_id=${projectId}&date=${date}`),
          fetch(`/api/team-members?project_id=${projectId}`),
          fetch(`/api/sprints?project_id=${projectId}&status=active`),
          fetch(`/api/standup/feedback?project_id=${projectId}&date=${date}`),
        ]);

        const [entriesData, membersData, sprintsData, feedbackData] = await Promise.all([
          readJsonDataOrThrow<StandupEntryRow[]>(entriesRes, 'standup entries'),
          readJsonDataOrThrow<StandupMemberRow[]>(membersRes, 'team members'),
          readJsonDataOrThrow<StandupSprintSummary[]>(sprintsRes, 'sprints'),
          readJsonDataOrThrow<StandupFeedbackRow[]>(feedbackRes, 'standup feedback'),
        ]);

        const sprint = sprintsData.find((item) => item.status === 'active') ?? sprintsData[0] ?? null;
        let storySummaries: StandupStorySummary[] = [];
        let nextStoriesCursor: string | null = null;

        if (sprint) {
          const storiesRes = await fetch(`/api/stories?project_id=${projectId}&sprint_id=${sprint.id}&limit=40`);
          if (!storiesRes.ok) throw new Error('Failed to load sprint stories');
          const storiesJson = await storiesRes.json().catch(() => null);
          if (!storiesJson || !('data' in storiesJson)) throw new Error('Failed to load sprint stories');
          const storyRows = storiesJson.data as StandupStoryRow[];
          nextStoriesCursor = storiesJson.meta?.nextCursor ?? null;
          const taskEntries = await Promise.all(
            storyRows.map(async (story) => {
              const taskRes = await fetch(`/api/tasks?story_id=${story.id}&limit=1`);
              const taskJson = await taskRes.json().catch(() => null) as { data?: StandupTaskRow[]; meta?: { totalCount?: number; doneCount?: number } } | null;
              if (!taskRes.ok || !taskJson || !Array.isArray(taskJson.data)) {
                throw new Error(`Failed to load task summary for story ${story.id}`);
              }
              return [story.id, {
                taskCount: taskJson.meta?.totalCount ?? taskJson.data.length,
                doneTaskCount: taskJson.meta?.doneCount ?? taskJson.data.filter((task) => task.status === 'done').length,
              }] as const;
            }),
          );
          const taskProgressByStoryId = Object.fromEntries(taskEntries);
          const memberLookup = membersData.reduce<Record<string, string>>((acc, member) => {
            acc[member.id] = member.name;
            return acc;
          }, {});
          storySummaries = storyRows.map((story) => buildStorySummary(story, taskProgressByStoryId[story.id] ?? { taskCount: 0, doneTaskCount: 0 }, memberLookup));
        }

        if (cancelled) return;

        setEntries(entriesData);
        setMembers(membersData);
        setFeedback(feedbackData);
        setActiveSprint(sprint);
        setStories(storySummaries);
        setStoriesNextCursor(nextStoriesCursor);
        setLoadError(null);
        setSaveError(null);
      } catch {
        if (!cancelled) setLoadError(t('loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [date, projectId, refreshToken, t]);

  const currentSprintStories = stories;
  const currentUserStories = useMemo(() => {
    if (!currentTeamMemberId) return [];
    const assigned = currentSprintStories.filter((story) => story.assignee_id === currentTeamMemberId && story.status !== 'done');
    return assigned.length > 0 ? assigned : currentSprintStories.filter((story) => story.status !== 'done');
  }, [currentSprintStories, currentTeamMemberId]);

  const summaryBadges = [
    activeSprint ? { label: activeSprint.title, variant: 'chip' as const } : { label: t('noActiveSprint'), variant: 'outline' as const },
    { label: t('sprintStoryCount', { count: stories.length }), variant: 'outline' as const },
    { label: t('taskProgress', { done: doneTasks, total: totalTasks }), variant: 'outline' as const },
  ];
  const headerBadges = loadError
    ? []
    : loading
      ? [{ label: t('loading'), variant: 'outline' as const }]
      : summaryBadges;

  async function handleSave() {
    if (!projectId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch('/api/standup', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          done,
          plan,
          blockers,
          sprint_id: activeSprint?.id ?? null,
          plan_story_ids: planStoryIds,
        }),
      });
      if (!response.ok) {
        throw new Error('Failed to save standup');
      }
      setRefreshToken((value) => value + 1);
    } catch {
      setSaveError(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function createFeedback(input: { standup_entry_id: string; review_type: StandupReviewType; feedback_text: string }) {
    const response = await fetch('/api/standup/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error('Failed to create feedback');
    setRefreshToken((value) => value + 1);
  }

  async function updateFeedback(feedbackId: string, input: { review_type?: StandupReviewType; feedback_text?: string }) {
    const response = await fetch(`/api/standup/feedback/${feedbackId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error('Failed to update feedback');
    setRefreshToken((value) => value + 1);
  }

  async function deleteFeedback(feedbackId: string) {
    const response = await fetch(`/api/standup/feedback/${feedbackId}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error('Failed to delete feedback');
    setRefreshToken((value) => value + 1);
  }

  if (!projectId) {
    return (
      <div className="space-y-4">
        <PageHeader
          eyebrow={tc('operatorSurface')}
          title={t('title')}
          description={t('surfaceDescription')}
        />
        <SectionCard>
          <SectionCardBody>
            <EmptyState title={shellT('projectSelectPrompt')} description={shellT('projectSelectDescription')} />
          </SectionCardBody>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={tc('operatorSurface')}
        title={t('title')}
        description={t('surfaceDescription')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {headerBadges.map((badge) => (
              <Badge key={badge.label} variant={badge.variant}>{badge.label}</Badge>
            ))}
            <OperatorInput
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="w-auto"
            />
          </div>
        }
      />

      {loadError ? (
        <SectionCard>
          <SectionCardBody>
            <EmptyState
              title={loadError}
              description={t('loadFailedDescription')}
              action={<Button variant="hero" onClick={() => setRefreshToken((value) => value + 1)}>{t('retry')}</Button>}
            />
          </SectionCardBody>
        </SectionCard>
      ) : null}

      {!loadError ? (
        <>
      <SectionCard>
        <SectionCardHeader>
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('currentSprint')}</h2>
            <p className="text-sm text-[color:var(--operator-muted)]">{t('currentSprintDescription')}</p>
          </div>
        </SectionCardHeader>
        <SectionCardBody>
          {loading ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {[1, 2, 3].map((item) => (
                <div key={item} className="h-28 animate-pulse rounded-2xl bg-[color:var(--operator-surface-soft)]" />
              ))}
            </div>
          ) : activeSprint ? (
            stories.length > 0 ? (
              <div className="space-y-3">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {stories.map((story) => (
                    <div key={story.id} className="rounded-2xl border border-white/8 bg-black/10 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{story.title}</p>
                        <Badge variant="outline">{story.status}</Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[color:var(--operator-muted)]">
                        <Badge variant="chip">{story.assignee_name ?? t('unknown')}</Badge>
                        <span>{t('taskProgress', { done: story.done_task_count, total: story.task_count })}</span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full rounded-full bg-[linear-gradient(135deg,var(--operator-primary),var(--operator-primary-strong))]"
                          style={{ width: `${story.task_count > 0 ? Math.round((story.done_task_count / story.task_count) * 100) : 0}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                {storiesNextCursor ? (
                  <div className="text-center">
                    <Button
                      variant="glass"
                      size="sm"
                      disabled={loadingMoreStories}
                      onClick={async () => {
                        if (!projectId || !activeSprint || !storiesNextCursor) return;
                        setLoadingMoreStories(true);
                        const storiesRes = await fetch(`/api/stories?project_id=${projectId}&sprint_id=${activeSprint.id}&limit=40&cursor=${encodeURIComponent(storiesNextCursor)}`);
                        if (!storiesRes.ok) throw new Error('Failed to load sprint stories');
                        const storiesJson = await storiesRes.json().catch(() => null);
                        if (!storiesJson || !('data' in storiesJson)) throw new Error('Failed to load sprint stories');
                        const storyRows = storiesJson.data as StandupStoryRow[];
                        const taskEntries = await Promise.all(
                          storyRows.map(async (story) => {
                            const taskRes = await fetch(`/api/tasks?story_id=${story.id}&limit=1`);
                            const taskJson = await taskRes.json().catch(() => null) as { data?: StandupTaskRow[]; meta?: { totalCount?: number; doneCount?: number } } | null;
                            if (!taskRes.ok || !taskJson || !Array.isArray(taskJson.data)) {
                              throw new Error(`Failed to load task summary for story ${story.id}`);
                            }
                            return [story.id, {
                              taskCount: taskJson.meta?.totalCount ?? taskJson.data.length,
                              doneTaskCount: taskJson.meta?.doneCount ?? taskJson.data.filter((task) => task.status === 'done').length,
                            }] as const;
                          }),
                        );
                        const taskProgressByStoryId = Object.fromEntries(taskEntries);
                        setStories((prev) => [...prev, ...storyRows.map((story) => buildStorySummary(story, taskProgressByStoryId[story.id] ?? { taskCount: 0, doneTaskCount: 0 }, memberNameById))]);
                        setStoriesNextCursor(storiesJson?.meta?.nextCursor ?? null);
                        setLoadingMoreStories(false);
                      }}
                    >
                      {loadingMoreStories ? t('loading') : t('loadMore')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : (
              <EmptyState title={t('noSprintStories')} description={t('noSprintStoriesDescription')} />
            )
          ) : (
            <EmptyState title={t('noActiveSprint')} description={t('noActiveSprintDescription')} />
          )}
        </SectionCardBody>
      </SectionCard>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
        <SectionCard>
          <SectionCardHeader>
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">✍️ {t('myStandup')}</h2>
              <p className="text-sm text-[color:var(--operator-muted)]">{t('myStandupDescription')}</p>
            </div>
          </SectionCardHeader>
          <SectionCardBody>
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3, 4].map((item) => (
                  <div key={item} className="h-20 animate-pulse rounded-2xl bg-[color:var(--operator-surface-soft)]" />
                ))}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="chip">{t('myStoryCount', { count: currentUserStories.length })}</Badge>
                  <Badge variant="outline">{t('linkedStoryCount', { count: planStoryIds.length })}</Badge>
                </div>
                <div>
                  <label className="block text-xs font-medium uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('done')}</label>
                  <OperatorTextarea
                    value={done}
                    onChange={(event) => setDone(event.target.value)}
                    rows={4}
                    placeholder={t('donePlaceholder')}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('plan')}</label>
                  <OperatorTextarea
                    value={plan}
                    onChange={(event) => setPlan(event.target.value)}
                    rows={4}
                    placeholder={t('planPlaceholder')}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('blockers')}</label>
                  <OperatorTextarea
                    value={blockers}
                    onChange={(event) => setBlockers(event.target.value)}
                    rows={3}
                    placeholder={t('blockersPlaceholder')}
                  />
                </div>

                <div className="space-y-3 rounded-3xl border border-white/8 bg-black/10 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('linkedStories')}</p>
                      <p className="text-sm text-[color:var(--operator-muted)]">{t('linkedStoriesDescription')}</p>
                    </div>
                    <Badge variant="outline">{t('linkedStoryCount', { count: planStoryIds.length })}</Badge>
                  </div>
                  {storyPickerStories.length > 0 ? (
                    <div className="space-y-2">
                      {storyPickerStories.map((story) => {
                        const checked = planStoryIds.includes(story.id);
                        return (
                          <label key={story.id} className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-muted/30 p-3 transition hover:bg-muted">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setPlanStoryIds((current) => (
                                  current.includes(story.id)
                                    ? current.filter((storyId) => storyId !== story.id)
                                    : [...current, story.id]
                                ));
                              }}
                              className="mt-1 h-4 w-4 rounded border-input bg-transparent text-primary"
                            />
                            <div className="min-w-0 flex-1 space-y-1">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-sm font-medium text-foreground">{story.title}</p>
                                <Badge variant="outline">{story.status}</Badge>
                              </div>
                              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                <Badge variant="chip">{story.assignee_name ?? t('unknown')}</Badge>
                                <span>{t('taskProgress', { done: story.done_task_count, total: story.task_count })}</span>
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <EmptyState title={t('noSprintStories')} description={t('noSprintStoriesDescription')} className="bg-transparent px-4 py-6" />
                  )}
                </div>

                <div className="space-y-2">
                  <Button variant="hero" size="lg" onClick={() => void handleSave()} disabled={saving} className="w-full sm:w-auto">
                    {saving ? t('saving') : t('save')}
                  </Button>
                  {saveError ? <p className="text-sm text-rose-300">{saveError}</p> : null}
                </div>
              </div>
            )}
          </SectionCardBody>
        </SectionCard>

        <SectionCard>
          <SectionCardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">👥 {t('team')}</h2>
                <p className="text-sm text-[color:var(--operator-muted)]">{t('teamDescription')}</p>
              </div>
              <Badge variant="outline">{t('entryCount', { count: entries.length })}</Badge>
            </div>
          </SectionCardHeader>
          <SectionCardBody>
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((item) => (
                  <div key={item} className="h-40 animate-pulse rounded-2xl bg-[color:var(--operator-surface-soft)]" />
                ))}
              </div>
            ) : members.length === 0 ? (
              <EmptyState title={t('noMembers')} description={t('noMembersDescription')} />
            ) : (
              <div className="space-y-6">
                {humanMembers.length > 0 ? (
                  <section className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t('people')}</h3>
                        <p className="text-xs text-[color:var(--operator-muted)]">{t('peopleDescription')}</p>
                      </div>
                      <Badge variant="chip">{t('memberCount', { count: humanMembers.length })}</Badge>
                    </div>
                    <div className="space-y-3">
                      {humanMembers.map((member) => (
                        <StandupReviewCard
                          key={member.id}
                          member={member}
                          entry={entryByAuthorId[member.id]}
                          currentMemberId={currentTeamMemberId}
                          stories={stories}
                          feedback={feedbackByEntryId[entryByAuthorId[member.id]?.id ?? ''] ?? []}
                          memberNameById={memberNameById}
                          onCreateFeedback={createFeedback}
                          onUpdateFeedback={updateFeedback}
                          onDeleteFeedback={deleteFeedback}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}

                {agentMembers.length > 0 ? (
                  <section className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t('agents')}</h3>
                        <p className="text-xs text-[color:var(--operator-muted)]">{t('agentsDescription')}</p>
                      </div>
                      <Badge variant="chip">{t('memberCount', { count: agentMembers.length })}</Badge>
                    </div>
                    <div className="space-y-3">
                      {agentMembers.map((member) => (
                        <StandupReviewCard
                          key={member.id}
                          member={member}
                          entry={entryByAuthorId[member.id]}
                          currentMemberId={currentTeamMemberId}
                          stories={stories}
                          feedback={feedbackByEntryId[entryByAuthorId[member.id]?.id ?? ''] ?? []}
                          memberNameById={memberNameById}
                          onCreateFeedback={createFeedback}
                          onUpdateFeedback={updateFeedback}
                          onDeleteFeedback={deleteFeedback}
                        />
                      ))}
                    </div>
                  </section>
                ) : null}
              </div>
            )}
          </SectionCardBody>
        </SectionCard>
      </div>
      </>
      ) : null}
    </div>
  );
}
