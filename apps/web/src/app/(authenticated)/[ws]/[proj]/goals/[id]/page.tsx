'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Pencil, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { useGoalsRoute } from '../goals-context';
import { EntityDispatchPanel } from '@/components/dispatch/entity-dispatch-panel';
import { ToastContainer, useToast } from '@/components/ui/toast';
import { OutcomeStatusBadge } from '@/components/outcome/outcome-status-badge';
import { EpicStatusTransition } from '@/components/epics/epic-status-transition';
import { HypothesesSection } from '@/components/hypotheses/hypotheses-section';

type EpicStatus = 'draft' | 'active' | 'done' | 'archived';
type EpicPriority = 'critical' | 'high' | 'medium' | 'low';

interface Story {
  id: string;
  title: string;
  status: string;
  story_points?: number;
  assignee_id?: string | null;
  assignee_name?: string | null;
}

interface Epic {
  id: string;
  title: string;
  description?: string | null;
  objective?: string | null;
  success_criteria?: string | null;
  status: EpicStatus;
  priority: EpicPriority;
  target_date?: string | null;
  target_sp?: number | null;
  assignee_id?: string | null;
  project_id?: string;
  created_at: string;
  stories?: Story[];
  success_hypothesis?: string | null;
  metric_definition?: Record<string, unknown> | null;
  measure_after?: string | null;
  outcome_status?: 'n_a' | 'pending' | 'hit' | 'miss' | null;
  outcome_result?: Record<string, unknown> | null;
}

// ─── Story status order for grouping ─────────────────────────────────────────

const STATUS_ORDER = ['in-progress', 'in-review', 'ready-for-dev', 'backlog', 'done', 'blocked'];

function groupByStatus(stories: Story[]): { status: string; items: Story[] }[] {
  const map = new Map<string, Story[]>();
  for (const s of stories) {
    const g = map.get(s.status) ?? [];
    g.push(s);
    map.set(s.status, g);
  }
  const ordered: { status: string; items: Story[] }[] = [];
  for (const st of STATUS_ORDER) {
    const items = map.get(st);
    if (items?.length) { ordered.push({ status: st, items }); map.delete(st); }
  }
  for (const [status, items] of map) {
    if (items.length) ordered.push({ status, items });
  }
  return ordered;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function storyStatusVariant(s: string): 'success' | 'info' | 'destructive' | 'secondary' {
  if (s === 'done') return 'success';
  if (s === 'in-progress' || s === 'in-review') return 'info';
  if (s === 'blocked') return 'destructive';
  return 'secondary';
}

function priorityBadgeVariant(p: EpicPriority) {
  if (p === 'critical') return 'destructive' as const;
  if (p === 'high') return 'secondary' as const;
  if (p === 'medium') return 'outline' as const;
  return 'chip' as const;
}

// story #2084 근본(유나양 규격): story #2017이 "신규 i18n 인프라 도입은 스코프 밖"이라며 이
// 화면을 로컬 한글 맵으로 정정했던 것 자체가 회귀 원인이었다 — 이번에 next-intl(goals
// 네임스페이스, 이미 존재하는 priorityCritical 등 키)로 정식 배선한다.
function priorityLabelKey(p: EpicPriority): 'priorityCritical' | 'priorityHigh' | 'priorityMedium' | 'priorityLow' {
  if (p === 'critical') return 'priorityCritical';
  if (p === 'high') return 'priorityHigh';
  if (p === 'medium') return 'priorityMedium';
  return 'priorityLow';
}

// story #2084 근본: 'ko-KR' 하드코딩이었다 — locale=en에서도 날짜가 한국어 형식으로
// 렌더되던 원인 중 하나(dashboard-activity-timeline.tsx와 동일하게 useLocale() 값을 받는다).
function formatDate(d: string | null | undefined, locale: string) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

// ─── UI components ────────────────────────────────────────────────────────────

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{done} / {total}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// story #2021 후속(PO 리뷰): components 객체를 렌더 함수 안에서 인라인으로 만들면 매 렌더
// 새 함수 참조가 되어 react-markdown이 서브트리를 리마운트한다(chat-bubble 근본원인과 동형).
// props/상태 의존 없는 순수 상수·자식도 stateless라 모듈 스코프로 끌어올려 참조를 고정한다.
const mdBodyComponents = {
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 text-sm leading-6">{children}</p>,
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="mb-2 text-lg font-bold">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="mb-2 text-base font-bold">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="mb-1.5 text-sm font-bold">{children}</h3>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="mb-2 ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li className="text-sm leading-6">{children}</li>,
  code: ({ children }: { children?: React.ReactNode }) => <code className="rounded px-1 py-0.5 font-mono text-sm bg-muted">{children}</code>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,
};

function MdBody({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdBodyComponents}>
      {content}
    </ReactMarkdown>
  );
}

// ─── Inline edit form ─────────────────────────────────────────────────────────

function EpicEditInline({ epic, onSaved, onCancel }: { epic: Epic; onSaved: (e: Epic) => void; onCancel: () => void }) {
  const t = useTranslations('goals');
  const [title, setTitle] = useState(epic.title);
  const [description, setDescription] = useState(epic.description ?? '');
  const [objective, setObjective] = useState(epic.objective ?? '');
  const [successCriteria, setSuccessCriteria] = useState(epic.success_criteria ?? '');
  const [priority, setPriority] = useState<EpicPriority>(epic.priority);
  const [targetDate, setTargetDate] = useState(epic.target_date?.slice(0, 10) ?? '');
  const [targetSp, setTargetSp] = useState(epic.target_sp !== undefined && epic.target_sp !== null ? String(epic.target_sp) : '');
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/goals/${epic.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          objective: objective.trim() || undefined,
          success_criteria: successCriteria.trim() || undefined,
          priority,
          ...(targetDate ? { target_date: targetDate } : {}),
          ...(targetSp ? { target_sp: Number(targetSp) } : {}),
        }),
      });
      if (!res.ok) throw new Error();
      const { data } = await res.json() as { data: Epic };
      onSaved({ ...data, stories: epic.stories });
    } finally {
      setSaving(false);
    }
  }, [title, description, objective, successCriteria, priority, targetDate, targetSp, epic, onSaved]);

  const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary';

  return (
    <div className="space-y-4">
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder={t('fieldTitlePlaceholder')} />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className={`${inputCls} resize-none`} placeholder={t('fieldDescriptionPlaceholder')} />
      <textarea value={objective} onChange={(e) => setObjective(e.target.value)} rows={3} className={`${inputCls} resize-none`} placeholder={t('fieldObjectivePlaceholder')} />
      <textarea value={successCriteria} onChange={(e) => setSuccessCriteria(e.target.value)} rows={3} className={`${inputCls} resize-none`} placeholder={t('fieldSuccessCriteriaPlaceholder')} />
      {/* RC#2: status select 제거 — 전용 transition(상세 헤더 컨트롤·⓶)·일반 PATCH 봉인(BE #1651). 편집=title/desc/objective/criteria/priority/target만. */}
      <div className="grid grid-cols-2 gap-3">
        <select value={priority} onChange={(e) => setPriority(e.target.value as EpicPriority)} className={inputCls}>
          <option value="critical">{t('priorityCritical')}</option>
          <option value="high">{t('priorityHigh')}</option>
          <option value="medium">{t('priorityMedium')}</option>
          <option value="low">{t('priorityLow')}</option>
        </select>
        <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className={inputCls} />
        <input type="number" min="0" value={targetSp} onChange={(e) => setTargetSp(e.target.value)} className={inputCls} placeholder={t('fieldTargetSp')} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>{t('cancel')}</Button>
        <Button size="sm" disabled={saving || !title.trim()} onClick={() => void handleSave()}>
          {saving ? t('saving') : t('saveChanges')}
        </Button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EpicDetailPage() {
  const t = useTranslations('goals');
  const locale = useLocale();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { wsSlug, projSlug } = useGoalsRoute();
  const { toasts, addToast, dismissToast } = useToast();
  const [epic, setEpic] = useState<Epic | null>(null);
  const [loading, setLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [epicAssigneeId, setEpicAssigneeId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    if (!epic) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/goals/${epic.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? t('saveFailed') });
        return;
      }
      router.replace(`/${wsSlug}/${projSlug}/goals`);
    } catch {
      addToast({ type: 'error', title: t('saveFailed') });
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [epic, router, addToast, wsSlug, projSlug, t]);

  useEffect(() => {
    fetch(`/api/goals/${id}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((json) => {
        const data = (json as { data: Epic }).data;
        setEpic(data);
        setEpicAssigneeId(data.assignee_id ?? null);
      })
      .catch(() => router.replace(`/${wsSlug}/${projSlug}/goals`))
      .finally(() => setLoading(false));
  }, [id, router, wsSlug, projSlug]);

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">{t('loading')}</div>;
  }
  if (!epic) return null;

  const stories = epic.stories ?? [];
  const done = stories.filter((s) => s.status === 'done').length;
  const spDone = stories.filter((s) => s.status === 'done').reduce((a, s) => a + (s.story_points ?? 0), 0);
  const spTotal = stories.reduce((a, s) => a + (s.story_points ?? 0), 0);
  const storyGroups = groupByStatus(stories);

  return (
    <>
      <TopBarSlot
        title={
          <div className="flex items-center gap-2">
            {/* story #1990: replace, 기본 push 아님 — 뒤로가기 재진입 트랩 방지(gates/chats와 동일 원칙, §3.2). */}
            <Link href={`/${wsSlug}/${projSlug}/goals`} replace className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3.5 w-3.5" />
              {t('backToList')}
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="text-sm font-medium truncate max-w-[200px]">{epic.title}</span>
          </div>
        }
      />

      <div className="mx-auto max-w-3xl px-4 py-6 space-y-8">
        {/* Header */}
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <h1 className="text-xl font-bold leading-tight">{epic.title}</h1>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setIsEditing((v) => !v)}
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
              >
                {isEditing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                {isEditing ? t('cancel') : t('edit')}
              </button>
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="flex items-center gap-1.5 rounded-lg border border-destructive/40 px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
                aria-label={t('deleteGoal')}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t('deleteGoal')}
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* RC#2 ⓶: status badge → transition 컨트롤(유효 next dropdown·draft→active gate-pending) */}
            <EpicStatusTransition
              epicId={epic.id}
              status={epic.status}
              onTransitioned={(s) => setEpic((prev) => (prev ? { ...prev, status: s as EpicStatus } : prev))}
            />
            <Badge variant={priorityBadgeVariant(epic.priority)}>{t(priorityLabelKey(epic.priority))}</Badge>
            {epic.outcome_status && epic.outcome_status !== 'n_a' ? <OutcomeStatusBadge status={epic.outcome_status} /> : null}
            {epic.target_date && <span className="text-xs text-muted-foreground">{t('targetDate')}: {formatDate(epic.target_date, locale)}</span>}
            {epic.target_sp != null && <span className="text-xs text-muted-foreground">{t('targetSp')}: {epic.target_sp}</span>}
          </div>
        </div>

        {/* Dispatch */}
        {epic.project_id && (
          <div className="rounded-xl border border-border bg-muted/20 p-4">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Dispatch</p>
            <EntityDispatchPanel
              entityType="epic"
              entityId={epic.id}
              projectId={epic.project_id}
              currentAssigneeId={epicAssigneeId}
              onAssigneePatched={(aid) => setEpicAssigneeId(aid)}
            />
          </div>
        )}

        {/* Edit form */}
        {isEditing && (
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <EpicEditInline
              epic={epic}
              onSaved={(updated) => { setEpic(updated); setIsEditing(false); }}
              onCancel={() => setIsEditing(false)}
            />
          </div>
        )}

        {!isEditing && (
          <>
            {/* Hypotheses — 1st-class entity section (E1-S8). Replaces the legacy
                OutcomeResultCard/inline outcome intent (AC5 · §12.3 공존 금지). */}
            {epic.project_id ? <HypothesesSection epicId={epic.id} projectId={epic.project_id} /> : null}

            {/* Description */}
            <section className="space-y-2">
              <h2 className="text-xs font-medium text-muted-foreground">{t('description')}</h2>
              {epic.description?.trim() ? (
                <MdBody content={epic.description} />
              ) : (
                <p className="text-sm italic text-muted-foreground">{t('noDescription')}</p>
              )}
            </section>

            {/* Objective */}
            {epic.objective?.trim() && (
              <section className="space-y-2">
                <h2 className="text-xs font-medium text-muted-foreground">{t('fieldObjective')}</h2>
                <MdBody content={epic.objective} />
              </section>
            )}

            {/* Success criteria */}
            {epic.success_criteria?.trim() && (
              <section className="space-y-2">
                <h2 className="text-xs font-medium text-muted-foreground">{t('fieldSuccessCriteria')}</h2>
                <MdBody content={epic.success_criteria} />
              </section>
            )}
          </>
        )}

        {/* Progress */}
        <section className="space-y-4">
          <h2 className="text-xs font-medium text-muted-foreground">{t('progress')}</h2>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">{t('storiesProgress')}</p>
            <ProgressBar done={done} total={stories.length} />
          </div>
          {spTotal > 0 && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">{t('spProgress')}</p>
              <ProgressBar done={spDone} total={spTotal} />
            </div>
          )}
        </section>

        {/* Stories — grouped by status */}
        <section className="space-y-4">
          <h2 className="text-xs font-medium text-muted-foreground">
            {t('stories')} ({stories.length})
          </h2>
          {stories.length === 0 ? (
            <p className="text-sm italic text-muted-foreground">{t('noStories')}</p>
          ) : (
            <div className="space-y-4">
              {storyGroups.map(({ status: groupStatus, items }) => (
                <div key={groupStatus}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <Badge variant={storyStatusVariant(groupStatus)} className="text-[10px]">
                      {groupStatus}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{t('itemCount', { count: items.length })}</span>
                  </div>
                  <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
                    {items.map((story) => (
                      <button
                        key={story.id}
                        type="button"
                        onClick={() => router.push(`/board?story=${story.id}`)}
                        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/50 transition-colors"
                      >
                        <span className="flex-1 truncate text-sm">{story.title}</span>
                        <div className="ml-3 flex shrink-0 items-center gap-2">
                          {story.assignee_name && (
                            <span className="text-xs text-muted-foreground truncate max-w-[80px]">{story.assignee_name}</span>
                          )}
                          {story.story_points != null && (
                            <span className="text-xs text-muted-foreground">{story.story_points} SP</span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Delete confirm dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('deleteConfirmDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(false)} disabled={deleting}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              {deleting ? t('deleting') : t('deleteConfirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
