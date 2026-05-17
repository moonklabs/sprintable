'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
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
import { EntityDispatchPanel } from '@/components/dispatch/entity-dispatch-panel';
import { ToastContainer, useToast } from '@/components/ui/toast';

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

function statusBadgeVariant(s: EpicStatus) {
  if (s === 'active') return 'info' as const;
  if (s === 'done') return 'success' as const;
  return 'secondary' as const;
}

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

function formatDate(d?: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
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

function MdBody({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 text-sm leading-6">{children}</p>,
        h1: ({ children }) => <h1 className="mb-2 text-lg font-bold">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 text-base font-bold">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1.5 text-sm font-bold">{children}</h3>,
        ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5">{children}</ol>,
        li: ({ children }) => <li className="text-sm leading-6">{children}</li>,
        code: ({ children }) => <code className="rounded px-1 py-0.5 font-mono text-[13px] bg-muted">{children}</code>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

// ─── Inline edit form ─────────────────────────────────────────────────────────

function EpicEditInline({ epic, onSaved, onCancel }: { epic: Epic; onSaved: (e: Epic) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(epic.title);
  const [description, setDescription] = useState(epic.description ?? '');
  const [objective, setObjective] = useState(epic.objective ?? '');
  const [successCriteria, setSuccessCriteria] = useState(epic.success_criteria ?? '');
  const [status, setStatus] = useState<EpicStatus>(epic.status);
  const [priority, setPriority] = useState<EpicPriority>(epic.priority);
  const [targetDate, setTargetDate] = useState(epic.target_date?.slice(0, 10) ?? '');
  const [targetSp, setTargetSp] = useState(epic.target_sp !== undefined && epic.target_sp !== null ? String(epic.target_sp) : '');
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/epics/${epic.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          objective: objective.trim() || undefined,
          success_criteria: successCriteria.trim() || undefined,
          status,
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
  }, [title, description, objective, successCriteria, status, priority, targetDate, targetSp, epic, onSaved]);

  const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40';

  return (
    <div className="space-y-4">
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder="제목" />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className={`${inputCls} resize-none`} placeholder="설명 (마크다운)" />
      <textarea value={objective} onChange={(e) => setObjective(e.target.value)} rows={3} className={`${inputCls} resize-none`} placeholder="목표 (Objective)" />
      <textarea value={successCriteria} onChange={(e) => setSuccessCriteria(e.target.value)} rows={3} className={`${inputCls} resize-none`} placeholder="성공 기준 (Success Criteria)" />
      <div className="grid grid-cols-2 gap-3">
        <select value={status} onChange={(e) => setStatus(e.target.value as EpicStatus)} className={inputCls}>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="done">Done</option>
          <option value="archived">Archived</option>
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value as EpicPriority)} className={inputCls}>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} className={inputCls} />
        <input type="number" min="0" value={targetSp} onChange={(e) => setTargetSp(e.target.value)} className={inputCls} placeholder="목표 SP" />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>취소</Button>
        <Button size="sm" disabled={saving || !title.trim()} onClick={() => void handleSave()}>
          {saving ? '저장 중…' : '저장'}
        </Button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function EpicDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
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
      const res = await fetch(`/api/epics/${epic.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? '에픽 삭제에 실패했습니다.' });
        return;
      }
      router.replace('/epics');
    } catch {
      addToast({ type: 'error', title: '에픽 삭제에 실패했습니다.' });
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }, [epic, router, addToast]);

  useEffect(() => {
    fetch(`/api/epics/${id}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((json) => {
        const data = (json as { data: Epic }).data;
        setEpic(data);
        setEpicAssigneeId(data.assignee_id ?? null);
      })
      .catch(() => router.replace('/epics'))
      .finally(() => setLoading(false));
  }, [id, router]);

  if (loading) {
    return <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">불러오는 중…</div>;
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
            <Link href="/epics" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3.5 w-3.5" />
              에픽 목록
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
                {isEditing ? '취소' : '편집'}
              </button>
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="flex items-center gap-1.5 rounded-lg border border-destructive/40 px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
                aria-label="에픽 삭제"
              >
                <Trash2 className="h-3.5 w-3.5" />
                삭제
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusBadgeVariant(epic.status)}>{epic.status}</Badge>
            <Badge variant={priorityBadgeVariant(epic.priority)}>{epic.priority}</Badge>
            {epic.target_date && <span className="text-xs text-muted-foreground">마감: {formatDate(epic.target_date)}</span>}
            {epic.target_sp != null && <span className="text-xs text-muted-foreground">목표 SP: {epic.target_sp}</span>}
          </div>
        </div>

        {/* Dispatch */}
        {epic.project_id && (
          <div className="rounded-xl border border-border bg-muted/20 p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dispatch</p>
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
            {/* Description */}
            <section className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">설명</h2>
              {epic.description?.trim() ? (
                <MdBody content={epic.description} />
              ) : (
                <p className="text-sm italic text-muted-foreground">설명이 없습니다.</p>
              )}
            </section>

            {/* Objective */}
            {epic.objective?.trim() && (
              <section className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">목표 (Objective)</h2>
                <MdBody content={epic.objective} />
              </section>
            )}

            {/* Success criteria */}
            {epic.success_criteria?.trim() && (
              <section className="space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">성공 기준</h2>
                <MdBody content={epic.success_criteria} />
              </section>
            )}
          </>
        )}

        {/* Progress */}
        <section className="space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">진행 상황</h2>
          <div>
            <p className="mb-1 text-xs text-muted-foreground">스토리 완료</p>
            <ProgressBar done={done} total={stories.length} />
          </div>
          {spTotal > 0 && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">SP 진행</p>
              <ProgressBar done={spDone} total={spTotal} />
            </div>
          )}
        </section>

        {/* Stories — grouped by status */}
        <section className="space-y-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            스토리 ({stories.length})
          </h2>
          {stories.length === 0 ? (
            <p className="text-sm italic text-muted-foreground">스토리가 없습니다.</p>
          ) : (
            <div className="space-y-4">
              {storyGroups.map(({ status: groupStatus, items }) => (
                <div key={groupStatus}>
                  <div className="mb-1.5 flex items-center gap-2">
                    <Badge variant={storyStatusVariant(groupStatus)} className="text-[10px]">
                      {groupStatus}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{items.length}건</span>
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
            <DialogTitle>에픽을 삭제하시겠습니까?</DialogTitle>
            <DialogDescription>
              이 작업은 되돌릴 수 없습니다. 에픽에 포함된 스토리는 연결이 해제됩니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setShowDeleteConfirm(false)} disabled={deleting}>
              취소
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleDelete()}
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
