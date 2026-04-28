'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, X, Play, StopCircle, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TopBarSlot } from '@/components/nav/top-bar-slot';

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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !startDate || !endDate) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/sprints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), start_date: startDate, end_date: endDate, project_id: projectId }),
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

// ─── Main Client ──────────────────────────────────────────────────────────────

export function SprintsClient({ projectId }: SprintsClientProps) {
  const t = useTranslations('sprints');

  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Sprint | null>(null);
  const [burndown, setBurndown] = useState<BurndownData | null>(null);
  const [loadingBurndown, setLoadingBurndown] = useState(false);
  const [sprintStories, setSprintStories] = useState<Story[]>([]);
  const [backlogStories, setBacklogStories] = useState<Story[]>([]);
  const [loadingStories, setLoadingStories] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [activating, setActivating] = useState(false);
  const [closing, setClosing] = useState(false);
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
    setBacklogStories([]);
    setActionError(null);

    try {
      const [burndownRes, storiesRes, backlogRes] = await Promise.all([
        fetch(`/api/sprints/${sprint.id}/burndown`),
        fetch(`/api/stories?project_id=${projectId}&sprint_id=${sprint.id}`),
        fetch(`/api/stories/backlog?project_id=${projectId}`),
      ]);
      if (burndownRes.ok) {
        const json = await burndownRes.json();
        setBurndown(json.data);
      }
      if (storiesRes.ok) {
        const json = await storiesRes.json();
        setSprintStories(json.data ?? []);
      }
      if (backlogRes.ok) {
        const json = await backlogRes.json();
        setBacklogStories(json.data ?? []);
      }
    } finally {
      setLoadingBurndown(false);
      setLoadingStories(false);
    }
  }, [projectId]);

  const handleSelect = useCallback(async (sprint: Sprint) => {
    setSelected(sprint);
    await loadSprintDetail(sprint);
  }, [loadSprintDetail]);

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

  const handleAssignStory = async (story: Story) => {
    try {
      const res = await fetch(`/api/stories/${story.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprint_id: selected?.id ?? null }),
      });
      if (!res.ok) return;
      if (selected) {
        setSprintStories((prev) => [...prev, { ...story, sprint_id: selected.id }]);
        setBacklogStories((prev) => prev.filter((s) => s.id !== story.id));
      }
    } catch { /* noop */ }
  };

  const handleUnassignStory = async (story: Story) => {
    try {
      const res = await fetch(`/api/stories/${story.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sprint_id: null }),
      });
      if (!res.ok) return;
      setSprintStories((prev) => prev.filter((s) => s.id !== story.id));
      setBacklogStories((prev) => [...prev, { ...story, sprint_id: null }]);
    } catch { /* noop */ }
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
                {sprint.start_date} ~ {sprint.end_date} · {sprint.duration}{t('days')}
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
        <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
          <X className="size-4" />
        </Button>
      </div>

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

      {/* Burndown */}
      {loadingBurndown ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : burndown ? (
        <div className="mb-6 space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('burndown')}</p>
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
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('burndown')}</p>
              <div className="flex gap-4 text-xs text-muted-foreground">
                <span>📉 {t('idealLine')}: {burndown.ideal_line[0]?.points ?? 0} → 0</span>
                <span>📊 {t('actualLine')}: {burndown.actual_line[0]?.points ?? 0} → {burndown.actual_line[burndown.actual_line.length - 1]?.points ?? 0}</span>
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
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('sprintStories')}</p>
        {loadingStories ? (
          <p className="text-xs text-muted-foreground">{t('loading')}</p>
        ) : sprintStories.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">{t('noSprintStories')}</p>
        ) : (
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
        )}
      </div>

      {/* Backlog assignment */}
      {selected.status !== 'closed' && backlogStories.length > 0 ? (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('backlog')}</p>
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
    </>
  );
}
