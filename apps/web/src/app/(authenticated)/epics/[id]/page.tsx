'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Pencil, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { EntityDispatchPanel } from '@/components/dispatch/entity-dispatch-panel';

type EpicStatus = 'draft' | 'active' | 'done' | 'archived';
type EpicPriority = 'critical' | 'high' | 'medium' | 'low';

interface Story {
  id: string;
  title: string;
  status: string;
  story_points?: number;
  assignee_id?: string;
}

interface Epic {
  id: string;
  title: string;
  description?: string;
  status: EpicStatus;
  priority: EpicPriority;
  target_date?: string;
  target_sp?: number;
  assignee_id?: string | null;
  project_id?: string;
  created_at: string;
  stories?: Story[];
}

function statusBadgeVariant(s: EpicStatus) {
  if (s === 'active') return 'info' as const;
  if (s === 'done') return 'success' as const;
  return 'secondary' as const;
}

function priorityBadgeVariant(p: EpicPriority) {
  if (p === 'critical') return 'destructive' as const;
  if (p === 'high') return 'secondary' as const;
  if (p === 'medium') return 'outline' as const;
  return 'chip' as const;
}

function formatDate(d?: string) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

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

function EpicEditInline({ epic, onSaved, onCancel }: { epic: Epic; onSaved: (e: Epic) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(epic.title);
  const [description, setDescription] = useState(epic.description ?? '');
  const [status, setStatus] = useState<EpicStatus>(epic.status);
  const [priority, setPriority] = useState<EpicPriority>(epic.priority);
  const [targetDate, setTargetDate] = useState(epic.target_date?.slice(0, 10) ?? '');
  const [targetSp, setTargetSp] = useState(epic.target_sp !== undefined ? String(epic.target_sp) : '');
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
  }, [title, description, status, priority, targetDate, targetSp, epic, onSaved]);

  const inputCls = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40';

  return (
    <div className="space-y-4">
      <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder="제목" />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} className={`${inputCls} resize-none`} placeholder="설명 (마크다운)" />
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

export default function EpicDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [epic, setEpic] = useState<Epic | null>(null);
  const [loading, setLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [epicAssigneeId, setEpicAssigneeId] = useState<string | null>(null);

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
            <button
              type="button"
              onClick={() => setIsEditing((v) => !v)}
              className="shrink-0 flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
            >
              {isEditing ? <X className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
              {isEditing ? '취소' : '편집'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
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

        {/* Description */}
        {!isEditing && (
          <div className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">설명</h2>
            {epic.description?.trim() ? (
              <MdBody content={epic.description} />
            ) : (
              <p className="text-sm italic text-muted-foreground">설명이 없는.</p>
            )}
          </div>
        )}

        {/* Progress */}
        <div className="space-y-4">
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
        </div>

        {/* Stories */}
        <div className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">스토리 ({stories.length})</h2>
          {stories.length > 0 ? (
            <div className="divide-y divide-border rounded-xl border border-border overflow-hidden">
              {stories.map((story) => (
                <button
                  key={story.id}
                  type="button"
                  onClick={() => router.push(`/board?story=${story.id}`)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/50 transition-colors"
                >
                  <span className="text-sm">{story.title}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    {story.story_points != null && (
                      <span className="text-xs text-muted-foreground">{story.story_points} SP</span>
                    )}
                    <Badge variant={story.status === 'done' ? 'success' : 'secondary'} className="text-[10px]">
                      {story.status}
                    </Badge>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm italic text-muted-foreground">스토리가 없는.</p>
          )}
        </div>
      </div>
    </>
  );
}
