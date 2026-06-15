'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronLeft, Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { OutcomeStatusBadge } from '@/components/outcome/outcome-status-badge';
import { HypothesesSummary } from '@/components/hypotheses/hypotheses-summary';

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
  success_hypothesis?: string | null;
  metric_definition?: Record<string, unknown> | null;
  measure_after?: string | null;
  outcome_status?: 'n_a' | 'pending' | 'hit' | 'miss' | null;
  outcome_result?: Record<string, unknown> | null;
  // E1 S8b: BE EpicResponse가 list 응답에 부착하는 연결 가설 집계(미부착 경로는 기본값).
  hypothesis_count?: number;
  risky_status?: string | null;
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
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{label}</span>
          <span>{done} / {total}</span>
        </div>
      ) : null}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
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
        <label className="text-xs font-medium text-muted-foreground">{t('fieldTitle')}</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('fieldTitlePlaceholder')}
          required
          className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldDescription')}</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('fieldDescriptionPlaceholder')}
          rows={3}
          className="w-full resize-none rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('fieldPriority')}</label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as EpicPriority)}
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="critical">{t('priorityCritical')}</option>
            <option value="high">{t('priorityHigh')}</option>
            <option value="medium">{t('priorityMedium')}</option>
            <option value="low">{t('priorityLow')}</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('fieldTargetSp')}</label>
          <input
            type="number"
            min="0"
            value={targetSp}
            onChange={(e) => setTargetSp(e.target.value)}
            placeholder="0"
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldTargetDate')}</label>
        <input
          type="date"
          value={targetDate}
          onChange={(e) => setTargetDate(e.target.value)}
          className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
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
        <label className="text-xs font-medium text-muted-foreground">{t('fieldTitle')}</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('fieldDescription')}</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="w-full resize-none rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('fieldStatus')}</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as EpicStatus)}
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="draft">{t('statusDraft')}</option>
            <option value="active">{t('statusActive')}</option>
            <option value="done">{t('statusDone')}</option>
            <option value="archived">{t('statusArchived')}</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('fieldPriority')}</label>
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as EpicPriority)}
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
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
          <label className="text-xs font-medium text-muted-foreground">{t('fieldTargetDate')}</label>
          <input
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">{t('fieldTargetSp')}</label>
          <input
            type="number"
            min="0"
            value={targetSp}
            onChange={(e) => setTargetSp(e.target.value)}
            placeholder="0"
            className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
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
  onDeleteRequest: (id: string) => void;
}

function EpicRow({ epic, isSelected, onClick, onDeleteRequest }: EpicRowProps) {
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
    <div
      className={`group relative w-full rounded-2xl border px-4 py-3.5 text-left transition-all duration-150 cursor-pointer ${
        isSelected
          ? 'border-primary/40 bg-primary/5'
          : 'border-border bg-card hover:border-primary/30 hover:bg-primary/5'
      }`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
    >
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold leading-snug text-foreground">{epic.title}</p>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant={statusBadgeVariant(epic.status)}>{statusLabel[epic.status]}</Badge>
            <Badge variant={priorityBadgeVariant(epic.priority)}>{priorityLabel[epic.priority]}</Badge>
            <button
              type="button"
              aria-label={t('deleteEpic')}
              onClick={(e) => { e.stopPropagation(); onDeleteRequest(epic.id); }}
              className="hidden group-hover:flex items-center justify-center rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {epic.description?.trim() ? (
          <p className="text-xs text-muted-foreground line-clamp-1">{epic.description.split('\n')[0]?.replace(/^#+\s*/, '')}</p>
        ) : null}

        {/* 가설요약 추가로 메타 항목이 늘어 고밀도 카드(마감일+SP초과 동반)가 narrow 폭서
            가로 오버플로 잠재 → flex-wrap 헤지(가디언 라이브게이트 선제·기존 행 robustness↑). */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {epic.target_date ? (
            <span>{t('targetDate')}: {formatDate(epic.target_date)}</span>
          ) : null}
          <span>{done}/{total} {t('stories')}</span>
          <HypothesesSummary count={epic.hypothesis_count ?? 0} riskyStatus={epic.risky_status ?? null} />
          {spExceeded ? (
            <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
              {t('spExceeded')}
            </span>
          ) : null}
        </div>

        {total > 0 ? (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : null}
        {epic.outcome_status && epic.outcome_status !== 'n_a' ? (
          <div className="pt-0.5">
            <OutcomeStatusBadge status={epic.outcome_status} />
          </div>
        ) : null}
      </div>
    </div>
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border/80 px-5 py-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground lg:hidden"
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
            <>
              <Button size="sm" variant="outline" onClick={() => router.push(`/epics/${epic.id}`)}>
                {t('viewFull')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setIsEditing(true)}>
                {t('editEpic')}
              </Button>
            </>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="hidden rounded-xl p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:block"
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
            <h2 className="text-base font-bold text-foreground">{epic.title}</h2>

            {/* Meta grid */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-muted px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('targetDate')}</p>
                <p className="mt-1 text-sm font-medium text-foreground">{formatDate(epic.target_date)}</p>
              </div>
              <div className="rounded-xl bg-muted px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('targetSp')}</p>
                <div className="mt-1 flex items-center gap-1.5">
                  <p className="text-sm font-medium text-foreground">{epic.target_sp !== undefined ? epic.target_sp : '—'}</p>
                  {spExceeded ? (
                    <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">{t('spExceeded')}</span>
                  ) : null}
                </div>
              </div>
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('description')}</p>
              <p className="text-sm leading-relaxed text-foreground">
                {epic.description?.trim() ? epic.description : <span className="italic text-muted-foreground">{t('noDescription')}</span>}
              </p>
            </div>

            {/* Progress */}
            <div className="space-y-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('storiesProgress')}</p>
              <ProgressBar done={storyProgress.done} total={storyProgress.total} label={`${t('doneStories')} / ${t('totalStories')}`} />
              {spProgress.total > 0 ? (
                <>
                  <div className="flex items-center gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('spProgress')}</p>
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
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('stories')}</p>
              {stories.length > 0 ? (
                <div className="space-y-1.5">
                  {stories.map((story) => (
                    <button
                      key={story.id}
                      type="button"
                      onClick={() => router.push(`/board?story=${story.id}`)}
                      className="flex w-full items-center justify-between rounded-xl border border-border px-3 py-2 text-left transition-colors hover:border-primary/30 hover:bg-primary/5"
                    >
                      <p className="text-sm text-foreground">{story.title}</p>
                      <div className="flex shrink-0 items-center gap-2">
                        {story.story_points !== undefined ? (
                          <span className="text-xs text-muted-foreground">{story.story_points} SP</span>
                        ) : null}
                        <Badge variant={story.status === 'done' ? 'success' : 'secondary'} className="text-[10px]">
                          {story.status}
                        </Badge>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm italic text-muted-foreground">{t('noStories')}</p>
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
        className="absolute inset-0 bg-overlay-backdrop backdrop-blur-[2px]"
        onClick={onClose}
        aria-label={t('cancel')}
      />
      <div className="relative z-10 flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col rounded-2xl border border-border bg-card shadow-xl">
        <div className="flex flex-shrink-0 items-center justify-between px-6 pb-4 pt-6">
          <h2 className="text-base font-bold text-foreground">{t('createEpic')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        {/* Scrollable body — long forms (outcome 추가 등) overflow the viewport otherwise;
            internal scroll keeps every field + the submit button reachable (S5). */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          <EpicCreateForm
            projectId={projectId}
            orgId={orgId}
            onCreated={(epic) => { onCreated(epic); onClose(); }}
            onCancel={onClose}
          />
        </div>
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
  const router = useRouter();
  const { toasts, addToast, dismissToast } = useToast();
  const [epics, setEpics] = useState<Epic[]>([]);
  const [selectedEpic, setSelectedEpic] = useState<Epic | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [epicsHasMore, setEpicsHasMore] = useState(false);
  const [epicsNextCursor, setEpicsNextCursor] = useState<string | null>(null);
  const [epicsLoadingMore, setEpicsLoadingMore] = useState(false);
  const [epicsLoadMoreError, setEpicsLoadMoreError] = useState(false);
  const [statusFilter, setStatusFilter] = useState<EpicStatus | 'all'>('all');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchEpics = useCallback(async (cursor?: string | null) => {
    try {
      const params = new URLSearchParams({ project_id: projectId, limit: '20' });
      if (cursor) params.set('cursor', cursor);
      const res = await fetch(`/api/epics?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to fetch epics: ${res.status}`);
      const { data, meta } = await res.json() as { data: Epic[]; meta?: { hasMore?: boolean; nextCursor?: string | null } };
      if (cursor) {
        // append 시 id 기준 중복 방어 (cursor 전진 버그 재발 대비 안전망)
        setEpics((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          return [...prev, ...(data ?? []).filter((e) => !seen.has(e.id))];
        });
      } else {
        setEpics(data ?? []);
      }
      setEpicsHasMore(meta?.hasMore ?? false);
      setEpicsNextCursor(meta?.nextCursor ?? null);
      setEpicsLoadMoreError(false);
    } catch (err) {
      // AC3: silent-swallow 금지 — 최소 로깅 + (더보기 실패 시) 인라인 표시
      console.error('[epics] 목록을 불러오지 못했습니다', err);
      if (cursor) setEpicsLoadMoreError(true);
    } finally {
      setLoading(false);
      setEpicsLoadingMore(false);
    }
  }, [projectId]);

  const loadMoreEpics = useCallback(async () => {
    if (!epicsHasMore || !epicsNextCursor || epicsLoadingMore) return;
    setEpicsLoadingMore(true);
    setEpicsLoadMoreError(false);
    await fetchEpics(epicsNextCursor);
  }, [epicsHasMore, epicsNextCursor, epicsLoadingMore, fetchEpics]);

  // (silent-catch sweep) `_fetchEpicDetail`(dead·호출처 0·handleSelectEpic이 /epics/[id]
  // 딥링크로 대체)는 제거했다 — 실행되지 않던 silent catch였으므로 toast가 아니라 dead code 삭제.

  const handleSelectEpic = useCallback((epic: Epic) => {
    // AC5: 모든 디바이스에서 /epics/[id] 딥링크로 이동
    router.push(`/epics/${epic.id}`);
  }, [router]);

  const handleDeleteEpic = useCallback(async (id: string) => {
    setDeleting(true);
    setEpics((prev) => prev.filter((e) => e.id !== id));
    setSelectedEpic((prev) => prev?.id === id ? null : prev);
    try {
      const res = await fetch(`/api/epics/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? '에픽 삭제에 실패했습니다.' });
        void fetchEpics();
      }
    } catch {
      addToast({ type: 'error', title: '에픽 삭제에 실패했습니다.' });
      void fetchEpics();
    } finally {
      setDeleting(false);
      setDeleteConfirmId(null);
    }
  }, [fetchEpics, addToast]);

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
      <>
        <TopBarSlot title={<h1 className="text-sm font-medium">{t('title')}</h1>} />
        <div className="flex h-64 items-center justify-center">
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        </div>
      </>
    );
  }

  const filteredEpics = statusFilter === 'all' ? epics : epics.filter((e) => e.status === statusFilter);

  const listPanel = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/35">

      {/* Status filter */}
      <div className="flex shrink-0 gap-1 px-4 pt-3 pb-1 flex-wrap">
        {(['all', 'draft', 'active', 'done', 'archived'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
              statusFilter === s
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted/50'
            }`}
          >
            {s === 'all' ? t('filterAll') : s}
          </button>
        ))}
      </div>

      {/* List body */}
      <div className="flex-1 overflow-y-auto p-4">
        {filteredEpics.length === 0 ? (
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
            {filteredEpics.map((epic) => (
              <EpicRow
                key={epic.id}
                epic={epic}
                isSelected={selectedEpic?.id === epic.id}
                onClick={() => { void handleSelectEpic(epic); }}
                onDeleteRequest={(id) => setDeleteConfirmId(id)}
              />
            ))}
            {epicsLoadMoreError ? (
              <div className="flex flex-col items-center gap-1 py-2">
                <p className="text-xs text-destructive">에픽을 더 불러오지 못했습니다.</p>
                <Button variant="ghost" size="sm" onClick={() => void loadMoreEpics()} disabled={epicsLoadingMore}>
                  {epicsLoadingMore ? '로딩 중...' : '다시 시도'}
                </Button>
              </div>
            ) : epicsHasMore ? (
              <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={() => void loadMoreEpics()} disabled={epicsLoadingMore}>
                {epicsLoadingMore ? '로딩 중...' : '더 보기'}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      <TopBarSlot
        title={<h1 className="text-sm font-medium">{t('title')}</h1>}
        actions={
          <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('newEpic')}
          </Button>
        }
      />

      {/* Desktop layout: list + slide-in detail panel */}
      <div className="hidden min-h-0 flex-1 overflow-hidden lg:flex lg:items-stretch lg:gap-0">
        <div className={`transition-all duration-300 ${selectedEpic ? 'w-[380px] shrink-0 border-r border-border/80' : 'w-full'}`}>
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
      <div className="flex flex-1 flex-col overflow-hidden lg:hidden">
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

      {/* Delete confirm dialog */}
      <Dialog open={!!deleteConfirmId} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>에픽을 삭제하시겠습니까?</DialogTitle>
            <DialogDescription>
              이 작업은 되돌릴 수 없습니다. 에픽에 포함된 스토리는 연결이 해제됩니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDeleteConfirmId(null)} disabled={deleting}>
              취소
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => { if (deleteConfirmId) void handleDeleteEpic(deleteConfirmId); }}
              disabled={deleting}
            >
              {deleting ? '삭제 중…' : '영구 삭제'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
