'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { OperatorInput, OperatorTextarea } from '@/components/ui/operator-control';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { formatSeoulDate } from '@/lib/date';
import { useDashboardContext } from '../../dashboard/dashboard-shell';
import { StandupBoardCard } from '@/components/standup/standup-board-card';
import { StandupFeedbackDialog } from '@/components/standup/standup-feedback-dialog';
import { StandupHistorySection } from '@/components/standup/standup-history-section';
import {
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

function shiftDate(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day + days);
  return formatSeoulDate(d);
}

export default function StandupPage() {
  const t = useTranslations('standup');
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
  const [sprintExpanded, setSprintExpanded] = useState(false);
  const [editingSelf, setEditingSelf] = useState(false);
  const [feedbackDialogMemberId, setFeedbackDialogMemberId] = useState<string | null>(null);

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

  const feedbackDialogMember = useMemo(
    () => members.find((m) => m.id === feedbackDialogMemberId) ?? null,
    [members, feedbackDialogMemberId],
  );
  const feedbackDialogEntry = feedbackDialogMemberId ? entryByAuthorId[feedbackDialogMemberId] : undefined;
  const feedbackDialogFeedback = feedbackDialogEntry ? (feedbackByEntryId[feedbackDialogEntry.id] ?? []) : [];

  useEffect(() => {
    setDone(currentEntry?.done ?? '');
    setPlan(currentEntry?.plan ?? '');
    setBlockers(currentEntry?.blockers ?? '');
    setPlanStoryIds(currentEntry?.plan_story_ids ?? []);
  }, [currentEntry?.id, currentEntry?.updated_at, currentEntry?.done, currentEntry?.plan, currentEntry?.blockers, currentEntry?.plan_story_ids]);

  useEffect(() => {
    setEditingSelf(false);
  }, [date]);

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

  const currentUserStories = useMemo(() => {
    if (!currentTeamMemberId) return [];
    const assigned = stories.filter((story) => story.assignee_id === currentTeamMemberId && story.status !== 'done');
    return assigned.length > 0 ? assigned : stories.filter((story) => story.status !== 'done');
  }, [stories, currentTeamMemberId]);

  const humanMembersSorted = useMemo(() => {
    if (!currentTeamMemberId) return humanMembers;
    return [
      ...humanMembers.filter((m) => m.id === currentTeamMemberId),
      ...humanMembers.filter((m) => m.id !== currentTeamMemberId),
    ];
  }, [humanMembers, currentTeamMemberId]);

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
      setEditingSelf(false);
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
      <>
        <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
        <div className="flex h-64 items-center justify-center p-6">
          <EmptyState title={shellT('projectSelectPrompt')} description={shellT('projectSelectDescription')} />
        </div>
      </>
    );
  }

  return (
    <>
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{t('title')}</h1>}
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="ghost" size="icon" onClick={() => setDate((d) => shiftDate(d, -1))} title={t('previousDay')}>
              ←
            </Button>
            <OperatorInput
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="w-auto"
            />
            <Button variant="ghost" size="icon" onClick={() => setDate((d) => shiftDate(d, 1))} title={t('nextDay')}>
              →
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDate(formatSeoulDate())}>
              {t('today')}
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/meetings/new?standup_date=${date}`}>{t('meetingNotes')}</Link>
            </Button>
          </div>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {headerBadges.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-border/80 px-6 py-3">
            {headerBadges.map((badge) => (
              <Badge key={badge.label} variant={badge.variant}>{badge.label}</Badge>
            ))}
          </div>
        ) : null}

        <div className="space-y-6 p-6">
          {loadError ? (
            <div className="rounded-xl border border-border bg-background p-6">
              <EmptyState
                title={loadError}
                description={t('loadFailedDescription')}
                action={<Button variant="hero" onClick={() => setRefreshToken((value) => value + 1)}>{t('retry')}</Button>}
              />
            </div>
          ) : null}

          {!loadError ? (
            <>
              {/* 스프린트 섹션 — 접을 수 있는 컴팩트 카드 */}
              <div className="rounded-xl border border-border bg-background">
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left"
                  onClick={() => setSprintExpanded((prev) => !prev)}
                >
                  <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t('currentSprint')}</h2>
                    {activeSprint ? (
                      <p className="text-xs text-[color:var(--operator-muted)]">{activeSprint.title} · {t('sprintStoryCount', { count: stories.length })}</p>
                    ) : (
                      <p className="text-xs text-[color:var(--operator-muted)]">{t('noActiveSprint')}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{t('taskProgress', { done: doneTasks, total: totalTasks })}</Badge>
                    <span className="text-xs text-[color:var(--operator-muted)]">{sprintExpanded ? t('collapseSprintStories') : t('expandSprintStories')}</span>
                  </div>
                </button>

                {sprintExpanded ? (
                  <div className="border-t border-border/60 p-4">
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
                              <div key={story.id} className="rounded-2xl border border-border/70 bg-background p-4 shadow-sm">
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
                  </div>
                ) : null}
              </div>

              {/* 사람 섹션 */}
              {loading ? (
                <section className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-[color:var(--operator-foreground)]">👤 {t('people')}</h2>
                  </div>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {[1, 2, 3].map((item) => (
                      <div key={item} className="h-48 animate-pulse rounded-xl bg-[color:var(--operator-surface-soft)]" />
                    ))}
                  </div>
                </section>
              ) : humanMembers.length > 0 ? (
                <section className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-[color:var(--operator-foreground)]">👤 {t('people')}</h2>
                    <Badge variant="chip">{t('memberCount', { count: humanMembers.length })}</Badge>
                  </div>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {humanMembersSorted.map((member) => {
                      const isCurrentUser = member.id === currentTeamMemberId;
                      const entry = entryByAuthorId[member.id];
                      const memberFeedback = feedbackByEntryId[entry?.id ?? ''] ?? [];

                      if (isCurrentUser && editingSelf) {
                        return (
                          <div key={member.id} className="col-span-full rounded-xl border border-[color:var(--operator-primary)]/40 bg-card p-4 shadow-sm space-y-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <h3 className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t('selfEditTitle')}</h3>
                              <Button variant="ghost" size="sm" onClick={() => setEditingSelf(false)}>{t('cancel')}</Button>
                            </div>

                            <div className="grid gap-4 md:grid-cols-3">
                              <div>
                                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-emerald-400">{t('done')}</label>
                                <OperatorTextarea
                                  value={done}
                                  onChange={(event) => setDone(event.target.value)}
                                  rows={4}
                                  placeholder={t('donePlaceholder')}
                                />
                              </div>
                              <div>
                                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[color:var(--operator-primary-soft)]">{t('plan')}</label>
                                <OperatorTextarea
                                  value={plan}
                                  onChange={(event) => setPlan(event.target.value)}
                                  rows={4}
                                  placeholder={t('planPlaceholder')}
                                />
                              </div>
                              <div>
                                <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-rose-300">{t('blockers')}</label>
                                <OperatorTextarea
                                  value={blockers}
                                  onChange={(event) => setBlockers(event.target.value)}
                                  rows={4}
                                  placeholder={t('blockersPlaceholder')}
                                />
                              </div>
                            </div>

                            <div className="space-y-3 rounded-xl border border-border/70 bg-muted/10 p-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-xs font-semibold uppercase tracking-wider text-[color:var(--operator-muted)]">{t('linkedStories')}</p>
                                <Badge variant="outline">{t('linkedStoryCount', { count: planStoryIds.length })}</Badge>
                              </div>
                              {storyPickerStories.length > 0 ? (
                                <div className="max-h-40 space-y-1.5 overflow-y-auto">
                                  {storyPickerStories.map((story) => {
                                    const checked = planStoryIds.includes(story.id);
                                    return (
                                      <label key={story.id} className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 bg-background p-2.5 transition hover:bg-muted/40">
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
                                          className="mt-0.5 h-4 w-4 rounded border-input bg-transparent text-primary"
                                        />
                                        <div className="min-w-0 flex-1 space-y-0.5">
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
                                <p className="text-sm text-[color:var(--operator-muted)]">{t('noSprintStories')}</p>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-3 pt-1">
                              <Button variant="hero" size="lg" onClick={() => void handleSave()} disabled={saving}>
                                {saving ? t('saving') : t('save')}
                              </Button>
                              <Button variant="outline" onClick={() => setEditingSelf(false)}>{t('cancel')}</Button>
                              {saveError ? <p className="text-sm text-rose-300">{saveError}</p> : null}
                            </div>
                          </div>
                        );
                      }

                      return (
                        <StandupBoardCard
                          key={member.id}
                          member={member}
                          entry={entry}
                          feedback={memberFeedback}
                          isCurrentUser={isCurrentUser}
                          activeSprintTitle={activeSprint?.title ?? null}
                          onEdit={isCurrentUser ? () => setEditingSelf(true) : undefined}
                          onOpenFeedback={() => setFeedbackDialogMemberId(member.id)}
                        />
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {/* 에이전트 섹션 */}
              {!loading && agentMembers.length > 0 ? (
                <section className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold text-[color:var(--operator-foreground)]">🤖 {t('agents')}</h2>
                    <Badge variant="chip">{t('memberCount', { count: agentMembers.length })}</Badge>
                  </div>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {agentMembers.map((member) => {
                      const entry = entryByAuthorId[member.id];
                      const memberFeedback = feedbackByEntryId[entry?.id ?? ''] ?? [];
                      return (
                        <StandupBoardCard
                          key={member.id}
                          member={member}
                          entry={entry}
                          feedback={memberFeedback}
                          isCurrentUser={false}
                          activeSprintTitle={activeSprint?.title ?? null}
                          onOpenFeedback={() => setFeedbackDialogMemberId(member.id)}
                        />
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {!loading && members.length === 0 ? (
                <EmptyState title={t('noMembers')} description={t('noMembersDescription')} />
              ) : null}

              {projectId ? <StandupHistorySection projectId={projectId} memberNameById={memberNameById} /> : null}
            </>
          ) : null}
        </div>
      </div>

      {/* 피드백 다이얼로그 */}
      {feedbackDialogMember ? (
        <StandupFeedbackDialog
          open={feedbackDialogMemberId !== null}
          onOpenChange={(next) => { if (!next) setFeedbackDialogMemberId(null); }}
          member={feedbackDialogMember}
          entry={feedbackDialogEntry}
          feedback={feedbackDialogFeedback}
          stories={stories}
          memberNameById={memberNameById}
          currentMemberId={currentTeamMemberId}
          onCreateFeedback={createFeedback}
          onUpdateFeedback={updateFeedback}
          onDeleteFeedback={deleteFeedback}
        />
      ) : null}
    </>
  );
}
