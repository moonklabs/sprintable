'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronLeft, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';

// ─── Types ────────────────────────────────────────────────────────────────────

type EpicStatus = 'draft' | 'active' | 'done' | 'archived';
type EpicPriority = 'critical' | 'high' | 'medium' | 'low';

interface Story {
  id: string;
  title: string;
  status: string;
  story_points?: number;
}

interface Epic {
  id: string;
  title: string;
  description?: string;
  status: EpicStatus;
  priority: EpicPriority;
  target_date?: string;
  target_sp?: number;
  created_at: string;
  stories?: Story[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusBadgeVariant(status: EpicStatus): 'secondary' | 'info' | 'success' | 'outline' {
  switch (status) {
    case 'active':
      return 'info';
    case 'done':
      return 'success';
    case 'draft':
    case 'archived':
    default:
      return 'secondary';
  }
}

function priorityBadgeVariant(priority: EpicPriority): 'destructive' | 'secondary' | 'outline' | 'chip' {
  switch (priority) {
    case 'critical':
      return 'destructive';
    case 'high':
      return 'secondary';
    case 'medium':
      return 'outline';
    case 'low':
    default:
      return 'chip';
  }
}

function calcStoryProgress(stories: Story[]): { done: number; total: number } {
  const total = stories.length;
  const done = stories.filter((s) => s.status === 'done').length;
  return { done, total };
}

function calcSpProgress(stories: Story[]): { done: number; total: number } {
  const total = stories.reduce((sum, s) => sum + (s.story_points ?? 0), 0);
  const done = stories
    .filter((s) => s.status === 'done')
    .reduce((sum, s) => sum + (s.story_points ?? 0), 0);
  return { done, total };
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ProgressBarProps {
  done: number;
  total: number;
  label?: string;
}

function ProgressBar({ done, total, label }: ProgressBarProps) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="space-y-1">
      {label ? (
        <div className="flex items-center justify-between text-xs text-[color:var(--operator-muted)]">
          <span>{label}</span>
          <span>{done} / {total}</span>
        </div>
      ) : null}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--operator-border,hsl(var(--border)))]">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Epic Create Form ─────────────────────────────────────────────────────────

interface EpicCreateFormProps {
  projectId: string;
  orgId?: string;
  onCreated: (epic: Epic) => void;
  onCancel: () => void;
}

function EpicCreateForm({ projectId, orgId, onCreated, onCancel }: EpicCreateFormProps) {
  const t = useTranslations('epics');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<EpicPriority>('medium');
  const [targetDate, setTargetDate] = useState('');
  const [targetSp, setTargetSp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        project_id: projectId,
        org_id: orgId,
      };
      if (targetDate) body.target_date = targetDate;
      if (targetSp) body.target_sp = Number(targetSp);

      const res = await fetch('/api/epics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error('Failed to create epic');

      const { data } = await res.json() as { data: Epic };
      onCreated(data);
    } catch {
      setError('에픽 생성에 실패했습니다. 다시 시도해 주세요.');
    } finally {
      setSubmitting(false);
    }
  }, [title, description, priority, targetDate, targetSp, projectId, orgId, onCreated]);

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-[color:var(--operator-muted)]">{t('fieldTitle')}</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('fieldTitlePlaceholder')}
          required
          className="w-full rounded-xl border border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)] px-3 py-2 text-sm text-[color:var(--operator-foreground)] placeholder:text-[color:var(--operator-muted)] focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-[color:var(--operator-muted)]">{t('fieldDescription')}</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('fieldDescriptionPlaceholder')}
          rows={3}
          className="w-full resize-none rounded-xl border border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)] px-3 py-2 text-sm text-[color:var(--operator-foreground)] placeholder:text-[color:var(--operator-muted)] focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[color:var(--operator-muted)]">{t('fieldPriority')}</label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as EpicPriority)}
            className="w-full rounded-xl border border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)] px-3 py-2 text-sm text-[color:var(--operator-foreground)] focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="critical">{t('priorityCritical')}</option>
            <option value="high">{t('priorityHigh')}</option>
            <option value="medium">{t('priorityMedium')}</option>
            <option value="low">{t('priorityLow')}</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[color:var(--operator-muted)]">{t('fieldTargetSp')}</label>
          <input
            type="number"
            min="0"
            value={targetSp}
            onChange={(e) => setTargetSp(e.target.value)}
            placeholder="0"
            className="w-full rounded-xl border border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)] px-3 py-2 text-sm text-[color:var(--operator-foreground)] placeholder:text-[color:var(--operator-muted)] focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-[color:var(--operator-muted)]">{t('fieldTargetDate')}</label>
        <input
          type="date"
          value={targetDate}
          onChange={(e) => setTargetDate(e.target.value)}
          className="w-full rounded-xl border border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)] px-3 py-2 text-sm text-[color:var(--operator-foreground)] focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !title.trim()}>
          {submitting ? '...' : t('createEpic')}
        </Button>
      </div>
    </form>
  );
}

// ─── Epic Edit Form ───────────────────────────────────────────────────────────

interface EpicEditFormProps {
  epic: Epic;
  onSaved: (epic: Epic) => void;
  onCancel: () => void;
}

function EpicEditForm({ epic, onSaved, onCancel }: EpicEditFormProps) {
  const t = useTranslations('epics');
  const [title, setTitle] = useState(epic.title);
  const [description, setDescription] = useState(epic.description ?? '');
  const [priority, setPriority] = useState<EpicPriority>(epic.priority);
  const [status, setStatus] = useState<EpicStatus>(epic.status);
  const [targetDate, setTargetDate] = useState(epic.target_date?.slice(0, 10) ?? '');
  const [targetSp, setTargetSp] = useState(epic.target_sp !== undefined ? String(epic.target_sp) : '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setSubmitting(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        status,
      };
      if (targetDate) body.target_date = targetDate;
      if (targetSp) body.target_sp = Number(targetSp);

      const res = await fetch(`/api/epics/${epic.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error('Failed to update epic');

      const { data } = await res.json() as { data: Epic };
      onSaved({ ...data, stories: epic.stories });
    } catch {
      setError('에픽 수정에 실패했습니다. 다시 시도해 주세요.');
    } finally {
      setSubmitting(false);
    }
  }, [title, description, priority, status, targetDate, targetSp, epic.id, epic.stories, onSaved]);

  return (
    <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-[color:var(--operator-muted)]">{t('fieldTitle')}</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className="w-full rounded-xl border border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)] px-3 py-2 text-sm text-[color:var(--operator-foreground)] placeholder:text-[color:var(--operator-muted)] focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-[color:var(--operator-muted)]">{t('fieldDescription')}</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="w-full resize-none rounded-xl border border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)] px-3 py-2 text-sm text-[color:var(--operator-foreground)] placeholder:text-[color:var(--operator-muted)] focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[color:var(--operator-muted)]">{t('fieldStatus')}</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as EpicStatus)}
            className="w-full rounded-xl border border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)] px-3 py-2 text-sm text-[color:var(--operator-foreground)] focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="draft">{t('statusDraft')}</option>
            <option value="active">{t('statusActive')}</option>
            <option value="done">{t('statusDone')}</option>
            <option value="archived">{t('statusArchived')}</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[color:var(--operator-muted)]">{t('fieldPriority')}</label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as EpicPriority)}
            className="w-full rounded-xl border border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)] px-3 py-2 text-sm text-[color:var(--operator-foreground)] focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="critical">{t('priorityCritical')}</option>
            <option value="high">{t('priorityHigh')}</option>
            <option value="medium">{t('priorityMedium')}</option>
            <option value="low">{t('priorityLow')}</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[color:var(--operator-muted)]">{t('fieldTargetDate')}</label>
          <input
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            className="w-full rounded-xl border border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)] px-3 py-2 text-sm text-[color:var(--operator-foreground)] focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-[color:var(--operator-muted)]">{t('fieldTargetSp')}</label>
          <input
            type="number"
            min="0"
            value={targetSp}
            onChange={(e) => setTargetSp(e.target.value)}
            placeholder="0"
            className="w-full rounded-xl border border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)] px-3 py-2 text-sm text-[color:var(--operator-foreground)] placeholder:text-[color:var(--operator-muted)] focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !title.trim()}>
          {submitting ? '...' : t('saveChanges')}
        </Button>
      </div>
    </form>
  );
}

// ─── Epic List Row ────────────────────────────────────────────────────────────

interface EpicRowProps {
  epic: Epic;
  isSelected: boolean;
  onClick: () => void;
}

function EpicRow({ epic, isSelected, onClick }: EpicRowProps) {
  const t = useTranslations('epics');
  const stories = epic.stories ?? [];
  const { done, total } = calcStoryProgress(stories);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const spProgress = calcSpProgress(stories);
  const spExceeded = typeof epic.target_sp === 'number' && epic.target_sp > 0 && spProgress.total > epic.target_sp;

  const statusLabel: Record<EpicStatus, string> = {
    draft: t('statusDraft'),
    active: t('statusActive'),
    done: t('statusDone'),
    archived: t('statusArchived'),
  };

  const priorityLabel: Record<EpicPriority, string> = {
    critical: t('priorityCritical'),
    high: t('priorityHigh'),
    medium: t('priorityMedium'),
    low: t('priorityLow'),
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-2xl border px-4 py-3.5 text-left transition-all duration-150 ${
        isSelected
          ? 'border-primary/40 bg-primary/5'
          : 'border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)] hover:border-primary/30 hover:bg-primary/5'
      }`}
    >
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold leading-snug text-[color:var(--operator-foreground)]">{epic.title}</p>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant={statusBadgeVariant(epic.status)}>{statusLabel[epic.status]}</Badge>
            <Badge variant={priorityBadgeVariant(epic.priority)}>{priorityLabel[epic.priority]}</Badge>
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-[color:var(--operator-muted)]">
          {epic.target_date ? (
            <span>{t('targetDate')}: {formatDate(epic.target_date)}</span>
          ) : null}
          <span>{done}/{total} {t('stories')}</span>
          {spExceeded ? (
            <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
              {t('spExceeded')}
            </span>
          ) : null}
        </div>

        {total > 0 ? (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--operator-border,hsl(var(--border)))]">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : null}
      </div>
    </button>
  );
}

// ─── Epic Detail Panel ────────────────────────────────────────────────────────

interface EpicDetailPanelProps {
  epic: Epic;
  onUpdate: (epic: Epic) => void;
  onClose: () => void;
}

function EpicDetailPanel({ epic, onUpdate, onClose }: EpicDetailPanelProps) {
  const t = useTranslations('epics');
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);

  const stories = epic.stories ?? [];
  const storyProgress = calcStoryProgress(stories);
  const spProgress = calcSpProgress(stories);
  const spExceeded = typeof epic.target_sp === 'number' && epic.target_sp > 0 && spProgress.total > epic.target_sp;

  const statusLabel: Record<EpicStatus, string> = {
    draft: t('statusDraft'),
    active: t('statusActive'),
    done: t('statusDone'),
    archived: t('statusArchived'),
  };

  const priorityLabel: Record<EpicPriority, string> = {
    critical: t('priorityCritical'),
    high: t('priorityHigh'),
    medium: t('priorityMedium'),
    low: t('priorityLow'),
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)]">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-[color:var(--operator-border,hsl(var(--border)))] px-5 py-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1 text-xs text-[color:var(--operator-muted)] transition-colors hover:text-[color:var(--operator-foreground)] lg:hidden"
          >
            <ChevronLeft className="size-3.5" />
            {t('backToList')}
          </button>
          <div className="flex items-center gap-1.5">
            <Badge variant={statusBadgeVariant(epic.status)}>{statusLabel[epic.status]}</Badge>
            <Badge variant={priorityBadgeVariant(epic.priority)}>{priorityLabel[epic.priority]}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isEditing ? (
            <Button size="sm" variant="outline" onClick={() => setIsEditing(true)}>
              {t('editEpic')}
            </Button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="hidden rounded-xl p-1.5 text-[color:var(--operator-muted)] transition-colors hover:bg-[color:var(--operator-surface-soft)] hover:text-[color:var(--operator-foreground)] lg:block"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        {isEditing ? (
          <div className="space-y-4">
            <EpicEditForm
              epic={epic}
              onSaved={(updated) => { onUpdate(updated); setIsEditing(false); }}
              onCancel={() => setIsEditing(false)}
            />
          </div>
        ) : (
          <div className="space-y-6">
            {/* Title */}
            <h2 className="text-base font-bold text-[color:var(--operator-foreground)]">{epic.title}</h2>

            {/* Meta grid */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-[color:var(--operator-surface-soft,hsl(var(--muted)))] px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('targetDate')}</p>
                <p className="mt-1 text-sm font-medium text-[color:var(--operator-foreground)]">{formatDate(epic.target_date)}</p>
              </div>
              <div className="rounded-xl bg-[color:var(--operator-surface-soft,hsl(var(--muted)))] px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('targetSp')}</p>
                <div className="mt-1 flex items-center gap-1.5">
                  <p className="text-sm font-medium text-[color:var(--operator-foreground)]">{epic.target_sp !== undefined ? epic.target_sp : '—'}</p>
                  {spExceeded ? (
                    <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">{t('spExceeded')}</span>
                  ) : null}
                </div>
              </div>
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('description')}</p>
              <p className="text-sm leading-relaxed text-[color:var(--operator-foreground)]">
                {epic.description?.trim() ? epic.description : <span className="italic text-[color:var(--operator-muted)]">{t('noDescription')}</span>}
              </p>
            </div>

            {/* Progress */}
            <div className="space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('storiesProgress')}</p>
              <ProgressBar done={storyProgress.done} total={storyProgress.total} label={`${t('doneStories')} / ${t('totalStories')}`} />
              {spProgress.total > 0 ? (
                <>
                  <div className="flex items-center gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('spProgress')}</p>
                    {spExceeded ? (
                      <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
                        {t('spExceededDetail', { total: spProgress.total, target: epic.target_sp ?? 0 })}
                      </span>
                    ) : null}
                  </div>
                  <ProgressBar done={spProgress.done} total={spProgress.total} label={`${t('doneSp')} / ${t('totalSp')}`} />
                </>
              ) : null}
            </div>

            {/* Story list */}
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--operator-muted)]">{t('stories')}</p>
              {stories.length > 0 ? (
                <div className="space-y-1.5">
                  {stories.map((story) => (
                    <button
                      key={story.id}
                      type="button"
                      onClick={() => router.push(`/board?story=${story.id}`)}
                      className="flex w-full items-center justify-between rounded-xl border border-[color:var(--operator-border,hsl(var(--border)))] px-3 py-2 text-left transition-colors hover:border-primary/30 hover:bg-primary/5"
                    >
                      <p className="text-sm text-[color:var(--operator-foreground)]">{story.title}</p>
                      <div className="flex shrink-0 items-center gap-2">
                        {story.story_points !== undefined ? (
                          <span className="text-xs text-[color:var(--operator-muted)]">{story.story_points} SP</span>
                        ) : null}
                        <Badge variant={story.status === 'done' ? 'success' : 'secondary'} className="text-[10px]">
                          {story.status}
                        </Badge>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm italic text-[color:var(--operator-muted)]">{t('noStories')}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Create Modal ─────────────────────────────────────────────────────────────

interface CreateModalProps {
  projectId: string;
  orgId?: string;
  onCreated: (epic: Epic) => void;
  onClose: () => void;
}

function CreateModal({ projectId, orgId, onCreated, onClose }: CreateModalProps) {
  const t = useTranslations('epics');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label={t('cancel')}
      />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)] p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-[color:var(--operator-foreground)]">{t('createEpic')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-1.5 text-[color:var(--operator-muted)] transition-colors hover:bg-[color:var(--operator-surface-soft)] hover:text-[color:var(--operator-foreground)]"
          >
            <X className="size-4" />
          </button>
        </div>
        <EpicCreateForm
          projectId={projectId}
          orgId={orgId}
          onCreated={(epic) => { onCreated(epic); onClose(); }}
          onCancel={onClose}
        />
      </div>
    </div>
  );
}

// ─── Main Client Component ────────────────────────────────────────────────────

interface EpicsClientProps {
  projectId: string;
  orgId?: string;
}

export function EpicsClient({ projectId, orgId }: EpicsClientProps) {
  const t = useTranslations('epics');
  const [epics, setEpics] = useState<Epic[]>([]);
  const [selectedEpic, setSelectedEpic] = useState<Epic | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');

  const fetchEpics = useCallback(async () => {
    try {
      const res = await fetch(`/api/epics?project_id=${projectId}`);
      if (!res.ok) throw new Error('Failed to fetch epics');
      const { data } = await res.json() as { data: Epic[] };
      setEpics(data ?? []);
    } catch {
      // noop — show empty state
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const fetchEpicDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/epics/${id}`);
      if (!res.ok) throw new Error('Failed to fetch epic');
      const { data } = await res.json() as { data: Epic };
      setSelectedEpic(data);
      setEpics((prev) => prev.map((e) => (e.id === id ? { ...e, stories: data.stories } : e)));
    } catch {
      // noop
    }
  }, []);

  const handleSelectEpic = useCallback(async (epic: Epic) => {
    setSelectedEpic(epic);
    setMobileView('detail');
    await fetchEpicDetail(epic.id);
  }, [fetchEpicDetail]);

  const handleCreated = useCallback((epic: Epic) => {
    setEpics((prev) => [epic, ...prev]);
    setSelectedEpic(epic);
    setMobileView('detail');
  }, []);

  const handleUpdate = useCallback((updated: Epic) => {
    setSelectedEpic(updated);
    setEpics((prev) => prev.map((e) => (e.id === updated.id ? updated : e)));
  }, []);

  useEffect(() => {
    void fetchEpics();
  }, [fetchEpics]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-[color:var(--operator-muted)]">{t('loading')}</p>
      </div>
    );
  }

  const listPanel = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[color:var(--operator-border,hsl(var(--border)))] bg-[color:var(--operator-surface)]">
      {/* List header */}
      <div className="flex shrink-0 items-center justify-between border-b border-[color:var(--operator-border,hsl(var(--border)))] px-5 py-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[color:var(--operator-muted)]">{t('title')}</p>
          <h1 className="text-lg font-bold text-[color:var(--operator-foreground)]">{t('title')}</h1>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="size-4" />
          <span className="hidden sm:inline">{t('newEpic')}</span>
        </Button>
      </div>

      {/* List body */}
      <div className="flex-1 overflow-y-auto p-4">
        {epics.length === 0 ? (
          <EmptyState
            title={t('noEpics')}
            description={t('noEpicsDescription')}
            action={
              <Button size="sm" onClick={() => setShowCreate(true)}>
                <Plus className="size-4" />
                {t('newEpic')}
              </Button>
            }
          />
        ) : (
          <div className="space-y-2">
            {epics.map((epic) => (
              <EpicRow
                key={epic.id}
                epic={epic}
                isSelected={selectedEpic?.id === epic.id}
                onClick={() => { void handleSelectEpic(epic); }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop layout: list + slide-in detail panel */}
      <div className="hidden lg:flex lg:gap-4 lg:items-stretch lg:min-h-[calc(100vh-9rem)]">
        <div className={`transition-all duration-300 ${selectedEpic ? 'w-[380px] shrink-0' : 'w-full'}`}>
          {listPanel}
        </div>
        {selectedEpic ? (
          <div className="flex-1 min-w-0">
            <EpicDetailPanel
              epic={selectedEpic}
              onUpdate={handleUpdate}
              onClose={() => setSelectedEpic(null)}
            />
          </div>
        ) : null}
      </div>

      {/* Mobile layout */}
      <div className="flex flex-col lg:hidden">
        {mobileView === 'list' ? (
          <div className="flex-1">{listPanel}</div>
        ) : (
          <div className="flex-1">
            {selectedEpic ? (
              <EpicDetailPanel
                epic={selectedEpic}
                onUpdate={handleUpdate}
                onClose={() => { setSelectedEpic(null); setMobileView('list'); }}
              />
            ) : null}
          </div>
        )}
      </div>

      {/* Create modal */}
      {showCreate ? (
        <CreateModal
          projectId={projectId}
          orgId={orgId}
          onCreated={handleCreated}
          onClose={() => setShowCreate(false)}
        />
      ) : null}
    </>
  );
}
