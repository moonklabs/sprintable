'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus, X, Play, StopCircle, ChevronRight, Trash2, AlertTriangle, Target, Clock, Users, Calendar } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { OutcomeIntentFields, type OutcomeIntentValue, type MetricDefinition } from '@/components/outcome/outcome-intent-fields';
import { OutcomeResultCard, type OutcomeResult } from '@/components/outcome/outcome-result-card';
import type { OutcomeStatus } from '@/components/outcome/outcome-status-badge';

// 8a2bbda2: 기간 표시는 start_date~end_date(진실)에서 계산한다. BE `duration` 필드(예 14)가
// 날짜 범위와 불일치하는 케이스가 있어 신뢰하지 않고, inclusive 일수(end−start+1)를 직접 산출한다.
function sprintDurationDays(startDate: string, endDate: string): number {
  const start = Date.parse(startDate);
  const end = Date.parse(endDate);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, Math.round((end - start) / 86_400_000) + 1);
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface Sprint {
  id: string;
  title: string;
  status: 'planning' | 'active' | 'closed';
  start_date: string;
  end_date: string;
  duration: number;
  velocity: number | null;
  report_doc_id: string | null;
  goal: string | null;
  capacity: number | null;
  team_size: number | null;
  success_hypothesis: string | null;
  metric_definition: MetricDefinition | null;
  measure_after: string | null;
  outcome_status: OutcomeStatus | null;
  outcome_result: OutcomeResult | null;
}

interface Story {
  id: string;
  title: string;
  status: string;
  story_points: number | null;
  sprint_id: string | null;
}

interface BurndownData {
  total_points: number;
  done_points: number;
  remaining_points: number;
  completion_pct: number;
  stories_count: number;
  done_count: number;
  ideal_line: Array<{ date: string; points: number }>;
  actual_line: Array<{ date: string; points: number }>;
}

interface SprintsClientProps {
  projectId: string;
  orgId: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusVariant(status: string): 'default' | 'secondary' | 'outline' {
  if (status === 'active') return 'default';
  if (status === 'closed') return 'secondary';
  return 'outline';
}

// ─── Create Dialog ────────────────────────────────────────────────────────────

interface CreateDialogProps {
  projectId: string;
  onCreated: (sprint: Sprint) => void;
  onClose: () => void;
}

function CreateDialog({ projectId, onCreated, onClose }: CreateDialogProps) {
  const t = useTranslations('sprints');
  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [goal, setGoal] = useState('');
  const [capacity, setCapacity] = useState('');
  const [teamSize, setTeamSize] = useState('');
  const [intent, setIntent] = useState<OutcomeIntentValue>({ success_hypothesis: '', metric_definition: null, measure_after: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !startDate || !endDate) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        goal: goal.trim() || null,
        // 미입력 시 null 대신 필드 omit — BFF createSprintSchema가 number().optional()이라 null은 거부하고 undefined(omit)는 통과한다.
        ...(capacity ? { capacity: Number(capacity) } : {}),
        ...(teamSize ? { team_size: Number(teamSize) } : {}),
        success_hypothesis: intent.success_hypothesis.trim() || null,
        metric_definition: intent.metric_definition,
        measure_after: intent.measure_after ? `${intent.measure_after}T00:00:00Z` : null,
      };
      const res = await fetch('/api/sprints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), start_date: startDate, end_date: endDate, project_id: projectId, ...payload }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { data } = await res.json() as { data: Sprint };
      onCreated(data);
    } catch {
      setError(t('createError'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} aria-label={t('cancel')} />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-background p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-foreground">{t('newSprint')}</h2>
          <button type="button" onClick={onClose} className="rounded-xl p-1.5 text-muted-foreground hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>
        <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('sprintTitle')}</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              placeholder={t('sprintTitlePlaceholder')}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('startDate')}</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('endDate')}</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
          </div>
          {/* 실행 계획(calm 라벨·Target lucide·장식 글리프 제거) */}
          <div className="space-y-2 rounded-xl border border-border bg-muted/20 p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Target className="size-3.5" />{t('planSection')}</p>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('goalLabel')}</label>
              <input
                type="text"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={t('goalPlaceholder')}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <Clock className="size-3.5" />{t('capacityLabel')}
                </label>
                <div className="relative">
                  <input
                    type="number"
                    min="0"
                    value={capacity}
                    onChange={(e) => setCapacity(e.target.value)}
                    placeholder="0"
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 pr-8 text-sm text-foreground tabular-nums placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">SP</span>
                </div>
              </div>
              <div className="space-y-1">
                <label className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <Users className="size-3.5" />{t('teamSizeLabel')}
                </label>
                <div className="relative">
                  <input
                    type="number"
                    min="1"
                    value={teamSize}
                    onChange={(e) => setTeamSize(e.target.value)}
                    placeholder="0"
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 pr-6 text-sm text-foreground tabular-nums placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">명</span>
                </div>
              </div>
            </div>
          </div>

          {/* 효과 가설(calm 라벨·Target lucide·장식 글리프 제거) */}
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Target className="size-3.5" />{t('hypothesisSection')}</p>
            <OutcomeIntentFields value={intent} onChange={setIntent} />
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('cancel')}</Button>
            <Button type="submit" size="sm" disabled={submitting || !title.trim() || !startDate || !endDate}>
              {submitting ? '...' : t('create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Delete Confirm Dialog ──────────────────────────────────────────────────────

interface DeleteConfirmDialogProps {
  sprintTitle: string;
  deleting: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

function DeleteConfirmDialog({ sprintTitle, deleting, error, onConfirm, onClose }: DeleteConfirmDialogProps) {
  const t = useTranslations('sprints');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} aria-label={t('cancel')} />
      <div role="alertdialog" aria-modal="true" className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-background p-6 shadow-xl">
        <div className="mb-3 flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-foreground">{t('deleteConfirmTitle')}</h2>
            <p className="mt-0.5 truncate text-sm font-medium text-muted-foreground">{sprintTitle}</p>
          </div>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">{t('deleteConfirmBody')}</p>
        {error ? <p className="mb-3 text-xs text-destructive">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={deleting}>{t('cancel')}</Button>
          <Button type="button" variant="destructive" size="sm" onClick={onConfirm} disabled={deleting}>
            <Trash2 className="size-4" />
            {deleting ? '...' : t('deleteConfirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Client ──────────────────────────────────────────────────────────────

export function SprintsClient({ projectId }: SprintsClientProps) {
  const t = useTranslations('sprints');
  const tc = useTranslations('common');
  const searchParams = useSearchParams();

  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Sprint | null>(null);
  const [burndown, setBurndown] = useState<BurndownData | null>(null);
  const [loadingBurndown, setLoadingBurndown] = useState(false);
  const [sprintStories, setSprintStories] = useState<Story[]>([]);
  const [sprintStoriesHasMore, setSprintStoriesHasMore] = useState(false);
  const [sprintStoriesNextCursor, setSprintStoriesNextCursor] = useState<string | null>(null);
  const [sprintStoriesLoadingMore, setSprintStoriesLoadingMore] = useState(false);
  const [backlogStories, setBacklogStories] = useState<Story[]>([]);
  const [backlogHasMore, setBacklogHasMore] = useState(false);
  const [backlogNextCursor, setBacklogNextCursor] = useState<string | null>(null);
  const [backlogLoadingMore, setBacklogLoadingMore] = useState(false);
  const [loadingStories, setLoadingStories] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [activating, setActivating] = useState(false);
  const [closing, setClosing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadSprints = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/sprints?project_id=${projectId}`);
      if (res.ok) {
        const json = await res.json();
        setSprints(json.data ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void loadSprints(); }, [loadSprints]);

  const loadSprintDetail = useCallback(async (sprint: Sprint) => {
    setLoadingBurndown(true);
    setLoadingStories(true);
    setBurndown(null);
    setSprintStories([]);
    setSprintStoriesHasMore(false);
    setSprintStoriesNextCursor(null);
    setBacklogStories([]);
    setBacklogHasMore(false);
    setBacklogNextCursor(null);
    setActionError(null);

    try {
      const [burndownRes, storiesRes, backlogRes] = await Promise.all([
        fetch(`/api/sprints/${sprint.id}/burndown`),
        fetch(`/api/stories?project_id=${projectId}&sprint_id=${sprint.id}&limit=20`),
        fetch(`/api/stories/backlog?project_id=${projectId}&limit=20`),
      ]);
      if (burndownRes.ok) {
        const json = await burndownRes.json();
        setBurndown(json.data);
      }
      if (storiesRes.ok) {
        const json = await storiesRes.json() as { data?: Story[]; meta?: { hasMore?: boolean; nextCursor?: string | null } };
        setSprintStories(json.data ?? []);
        setSprintStoriesHasMore(json.meta?.hasMore ?? false);
        setSprintStoriesNextCursor(json.meta?.nextCursor ?? null);
      }
      if (backlogRes.ok) {
        const json = await backlogRes.json() as { data?: Story[]; meta?: { hasMore?: boolean; nextCursor?: string | null } };
        setBacklogStories(json.data ?? []);
        setBacklogHasMore(json.meta?.hasMore ?? false);
        setBacklogNextCursor(json.meta?.nextCursor ?? null);
      }
    } finally {
      setLoadingBurndown(false);
      setLoadingStories(false);
    }
  }, [projectId]);

  const loadMoreSprintStories = useCallback(async () => {
    if (!selected || !sprintStoriesNextCursor || sprintStoriesLoadingMore) return;
    setSprintStoriesLoadingMore(true);
    try {
      const res = await fetch(`/api/stories?project_id=${projectId}&sprint_id=${selected.id}&limit=20&cursor=${sprintStoriesNextCursor}`);
      if (res.ok) {
        const json = await res.json() as { data?: Story[]; meta?: { hasMore?: boolean; nextCursor?: string | null } };
        setSprintStories((prev) => [...prev, ...(json.data ?? [])]);
        setSprintStoriesHasMore(json.meta?.hasMore ?? false);
        setSprintStoriesNextCursor(json.meta?.nextCursor ?? null);
      }
    } finally {
      setSprintStoriesLoadingMore(false);
    }
  }, [selected, projectId, sprintStoriesNextCursor, sprintStoriesLoadingMore]);

  const loadMoreBacklog = useCallback(async () => {
    if (!backlogNextCursor || backlogLoadingMore) return;
    setBacklogLoadingMore(true);
    try {
      const res = await fetch(`/api/stories/backlog?project_id=${projectId}&limit=20&cursor=${backlogNextCursor}`);
      if (res.ok) {
        const json = await res.json() as { data?: Story[]; meta?: { hasMore?: boolean; nextCursor?: string | null } };
        setBacklogStories((prev) => [...prev, ...(json.data ?? [])]);
        setBacklogHasMore(json.meta?.hasMore ?? false);
        setBacklogNextCursor(json.meta?.nextCursor ?? null);
      }
    } finally {
      setBacklogLoadingMore(false);
    }
  }, [projectId, backlogNextCursor, backlogLoadingMore]);

  const handleSelect = useCallback(async (sprint: Sprint) => {
    setSelected(sprint);
    await loadSprintDetail(sprint);
  }, [loadSprintDetail]);

  // ?id= 파라미터로 sprint 자동 선택 (알림 딥링크 지원)
  useEffect(() => {
    const sprintId = searchParams.get('id');
    if (!sprintId || sprints.length === 0 || selected?.id === sprintId) return;
    const sprint = sprints.find((s) => s.id === sprintId);
    if (sprint) void handleSelect(sprint);
  }, [searchParams, sprints, selected, handleSelect]);

  const handleActivate = async () => {
    if (!selected) return;
    setActivating(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/sprints/${selected.id}/activate`, { method: 'POST' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: { message?: string } };
        setActionError(json.error?.message ?? t('activateError'));
        return;
      }
      await loadSprints();
      setSelected((prev) => prev ? { ...prev, status: 'active' } : prev);
    } finally {
      setActivating(false);
    }
  };

  const handleClose = async () => {
    if (!selected) return;
    if (!confirm(t('closeConfirm'))) return;
    setClosing(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/sprints/${selected.id}/close`, { method: 'POST' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: { message?: string } };
        setActionError(json.error?.message ?? t('closeError'));
        return;
      }
      await loadSprints();
      setSelected((prev) => prev ? { ...prev, status: 'closed' } : prev);
    } finally {
      setClosing(false);
    }
  };

  const handleDelete = async () => {
    if (!selected || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/sprints/${selected.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: { message?: string } };
        setDeleteError(json.error?.message ?? t('deleteError'));
        return;
      }
      // 삭제 성공 — 목록에서 제거하고 상세 패널·다이얼로그를 닫는다.
      const deletedId = selected.id;
      setSprints((prev) => prev.filter((s) => s.id !== deletedId));
      setShowDeleteConfirm(false);
      setSelected(null);
    } catch {
      setDeleteError(t('deleteError'));
    } finally {
      setDeleting(false);
    }
  };

  const handleAssignStory = async (story: Story) => {
    try {
      const res = await fetch(`/api/stories/${story.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprint_id: selected?.id ?? null }),
      });
      if (!res.ok) { console.error('스토리 스프린트 배정 실패', res.status); return; }
      if (selected) {
        setSprintStories((prev) => [...prev, { ...story, sprint_id: selected.id }]);
        setBacklogStories((prev) => prev.filter((s) => s.id !== story.id));
      }
    } catch (err) {
      // 71798d24: 에러를 조용히 무시하지 않는다(background 액션 — console.error).
      console.error('스토리 스프린트 배정 실패', err);
    }
  };

  const handleUnassignStory = async (story: Story) => {
    try {
      const res = await fetch(`/api/stories/${story.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprint_id: null }),
      });
      if (!res.ok) { console.error('스토리 스프린트 해제 실패', res.status); return; }
      setSprintStories((prev) => prev.filter((s) => s.id !== story.id));
      setBacklogStories((prev) => [...prev, { ...story, sprint_id: null }]);
    } catch (err) {
      // 71798d24: 에러를 조용히 무시하지 않는다(background 액션 — console.error).
      console.error('스토리 스프린트 해제 실패', err);
    }
  };

  if (loading) {
    return <p className="p-6 text-sm text-muted-foreground">{t('loading')}</p>;
  }

  return (
    <>
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{t('title')}</h1>}
        actions={
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="size-4" />
            <span className="hidden sm:inline">{t('newSprint')}</span>
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Sprint list */}
      <div className={`flex flex-col gap-3 overflow-y-auto p-6 transition-all duration-300 ${selected ? 'hidden w-1/2 lg:flex' : 'w-full'}`}>
        {sprints.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noSprints')}</p>
        ) : (
          <ul className="space-y-2">
            {sprints.map((sprint) => (
              <li
                key={sprint.id}
                onClick={() => void handleSelect(sprint)}
                className={`cursor-pointer rounded-lg border p-4 transition hover:bg-muted/40 ${selected?.id === sprint.id ? 'border-primary bg-muted/40' : 'border-border'}`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground">{sprint.title}</span>
                  <div className="flex items-center gap-2">
                  <Badge variant={statusVariant(sprint.status)}>{sprint.status}</Badge>
                  <ChevronRight className="size-4 text-muted-foreground" />
                  </div>
                </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {sprint.start_date} ~ {sprint.end_date} · {sprintDurationDays(sprint.start_date, sprint.end_date)}{t('days')}
              </p>
              {sprint.report_doc_id ? (
                <a
                  href={`/docs?id=${sprint.report_doc_id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  📄 {t('viewReport')}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>

  {/* Detail panel */}
  {selected ? (
    <div className="flex w-full flex-col overflow-y-auto border-l border-border p-6 lg:w-1/2">
      {/* Header */}
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{selected.title}</h2>
          <Badge variant={statusVariant(selected.status)} className="mt-1">{selected.status}</Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setDeleteError(null); setShowDeleteConfirm(true); }}
            aria-label={t('delete')}
            title={t('delete')}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(null)} aria-label={t('cancel')}>
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Goal */}
      {selected.goal ? (
        <p className="mb-3 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm text-foreground">
          <span className="mr-1.5 inline-flex items-center gap-1 align-middle text-xs font-medium text-muted-foreground"><Target className="size-3 shrink-0" />목표</span>
          {selected.goal}
        </p>
      ) : null}

      {/* Plan stats */}
      {(selected.capacity != null || selected.team_size != null) ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {selected.capacity != null ? (
            <span className="flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2.5 py-1 text-xs font-medium tabular-nums text-foreground">
              <Clock className="size-3.5 text-muted-foreground" />
              {selected.capacity}<span className="ml-0.5 text-muted-foreground">SP</span>
            </span>
          ) : null}
          {selected.team_size != null ? (
            <span className="flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2.5 py-1 text-xs font-medium tabular-nums text-foreground">
              <Users className="size-3.5 text-muted-foreground" />
              {selected.team_size}<span className="ml-0.5 text-muted-foreground">명</span>
            </span>
          ) : null}
          <span className="flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2.5 py-1 text-xs font-medium tabular-nums text-foreground">
            <Calendar className="size-3.5 text-muted-foreground" />
            {sprintDurationDays(selected.start_date, selected.end_date)}{t('days')}
          </span>
        </div>
      ) : null}

      {/* Action buttons */}
      {selected.status === 'planning' ? (
        <Button size="sm" className="mb-4 w-full" onClick={() => void handleActivate()} disabled={activating}>
          <Play className="size-4" />
          {activating ? '...' : t('activate')}
        </Button>
      ) : null}
      {selected.status === 'active' ? (
        <Button size="sm" variant="outline" className="mb-4 w-full" onClick={() => void handleClose()} disabled={closing}>
          <StopCircle className="size-4" />
          {closing ? '...' : t('close')}
        </Button>
      ) : null}
      {actionError ? <p className="mb-3 text-xs text-destructive">{actionError}</p> : null}

      {/* Outcome result card */}
      {selected.outcome_status && selected.outcome_status !== 'n_a' ? (
        <div className="mb-4">
          <OutcomeResultCard
            status={selected.outcome_status}
            hypothesis={selected.success_hypothesis}
            result={selected.outcome_result as OutcomeResult | null}
            pendingMetricLabel={selected.metric_definition?.metric}
          />
        </div>
      ) : null}

      {/* Burndown */}
      {loadingBurndown ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : burndown ? (
        <div className="mb-6 space-y-3">
          <p className="text-xs font-medium text-muted-foreground">{t('burndown')}</p>
          {/* 진행 바 — 기존 completion_pct 시각화(새 데이터 0·번다운 주인공) */}
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-success transition-all" style={{ width: `${burndown.completion_pct}%` }} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border border-border bg-muted/30 p-2 text-center">
              <p className="text-xl font-bold text-foreground">{burndown.completion_pct}%</p>
              <p className="text-[10px] text-muted-foreground">{t('completionRate')}</p>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-2 text-center">
              <p className="text-xl font-bold text-foreground">{burndown.done_points}<span className="text-xs text-muted-foreground">/{burndown.total_points}</span></p>
              <p className="text-[10px] text-muted-foreground">SP</p>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-2 text-center">
              <p className="text-xl font-bold text-foreground">{burndown.done_count}<span className="text-xs text-muted-foreground">/{burndown.stories_count}</span></p>
              <p className="text-[10px] text-muted-foreground">{t('stories')}</p>
            </div>
          </div>
          {burndown.ideal_line.length > 0 ? (
            <div className="rounded-md border border-border p-3">
              <p className="mb-1 text-xs font-medium text-muted-foreground">{t('burndown')}</p>
              <div className="flex gap-4 text-xs text-muted-foreground">
                <span>{t('idealLine')}: {burndown.ideal_line[0]?.points ?? 0} → 0</span>
                <span>{t('actualLine')}: {burndown.actual_line[0]?.points ?? 0} → {burndown.actual_line[burndown.actual_line.length - 1]?.points ?? 0}</span>
              </div>
            </div>
          ) : null}
          {selected.report_doc_id ? (
            <a
              href={`/docs?id=${selected.report_doc_id}`}
              className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm font-medium text-primary transition hover:bg-primary/10"
            >
              📄 {t('viewReport')}
            </a>
          ) : null}
        </div>
      ) : null}

      {/* Sprint stories */}
      <div className="mb-4 space-y-2">
        <p className="text-xs font-medium text-muted-foreground">{t('sprintStories')}</p>
        {loadingStories ? (
          <p className="text-xs text-muted-foreground">{t('loading')}</p>
        ) : sprintStories.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">{t('noSprintStories')}</p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {sprintStories.map((story) => (
                <li key={story.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                  <span className="text-sm text-foreground truncate">{story.title}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    {story.story_points != null ? <span className="text-xs text-muted-foreground">{story.story_points}SP</span> : null}
                    {selected.status !== 'closed' ? (
                      <button
                        type="button"
                        onClick={() => void handleUnassignStory(story)}
                        className="text-xs text-muted-foreground hover:text-destructive"
                        title={t('unassign')}
                      >
                        <X className="size-3" />
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {sprintStoriesHasMore && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 w-full text-xs text-muted-foreground"
                disabled={sprintStoriesLoadingMore}
                onClick={() => void loadMoreSprintStories()}
              >
                {sprintStoriesLoadingMore ? tc('loading') : tc('loadMore')}
              </Button>
            )}
          </>
        )}
      </div>

      {/* Backlog assignment */}
      {selected.status !== 'closed' && backlogStories.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t('backlog')}</p>
          <ul className="space-y-1.5">
            {backlogStories.map((story) => (
              <li key={story.id} className="flex items-center justify-between rounded-lg border border-dashed border-border px-3 py-2 hover:border-primary/40 hover:bg-primary/5 transition-colors">
                <span className="text-sm text-muted-foreground truncate">{story.title}</span>
                <button
                  type="button"
                  onClick={() => void handleAssignStory(story)}
                  className="shrink-0 text-xs font-medium text-primary hover:underline"
                >
                  {t('assign')}
                </button>
              </li>
            ))}
          </ul>
          {backlogHasMore && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs text-muted-foreground"
              disabled={backlogLoadingMore}
              onClick={() => void loadMoreBacklog()}
            >
              {backlogLoadingMore ? tc('loading') : tc('loadMore')}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  ) : null}
    </div>

      {showCreate ? (
        <CreateDialog
          projectId={projectId}
          onCreated={(sprint) => {
            setSprints((prev) => [sprint, ...prev]);
            setShowCreate(false);
          }}
          onClose={() => setShowCreate(false)}
        />
      ) : null}

      {showDeleteConfirm && selected ? (
        <DeleteConfirmDialog
          sprintTitle={selected.title}
          deleting={deleting}
          error={deleteError}
          onConfirm={() => void handleDelete()}
          onClose={() => { if (!deleting) setShowDeleteConfirm(false); }}
        />
      ) : null}
    </>
  );
}
