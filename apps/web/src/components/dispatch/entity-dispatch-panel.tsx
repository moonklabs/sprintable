'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToastContainer, useToast } from '@/components/ui/toast';

interface TeamMember {
  id: string;
  name: string;
  type: 'human' | 'agent';
  is_active: boolean;
}

interface EntityDispatchPanelProps {
  entityType: 'doc' | 'epic' | 'story';
  entityId: string;
  projectId: string;
  currentAssigneeId?: string | null;
  onAssigneePatched?: (assigneeId: string) => void;
  mobileMode?: 'full' | 'assignee-only';
}

export function EntityDispatchPanel({
  entityType,
  entityId,
  projectId,
  currentAssigneeId,
  onAssigneePatched,
  mobileMode,
}: EntityDispatchPanelProps) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [assigneeId, setAssigneeId] = useState<string>(currentAssigneeId ?? '');
  const [dispatching, setDispatching] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const { toasts, addToast, dismissToast } = useToast();

  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', handler as EventListener);
    document.addEventListener('touchstart', handler as EventListener);
    return () => {
      document.removeEventListener('mousedown', handler as EventListener);
      document.removeEventListener('touchstart', handler as EventListener);
    };
  }, [moreOpen]);

  useEffect(() => {
    fetch(`/api/team-members?project_id=${projectId}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((json) => {
        const data = (json?.data ?? json) as TeamMember[];
        setMembers(data.filter((m) => m.is_active));
      })
      .catch(() => {});
  }, [projectId]);

  const handleDispatch = useCallback(async () => {
    if (!assigneeId || dispatching) return;
    setDispatching(true);
    try {
      const patchPath = entityType === 'doc' ? `/api/docs/${entityId}` : `/api/epics/${entityId}`;
      if (entityType !== 'story') {
        const patchRes = await fetch(patchPath, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignee_id: assigneeId }),
        });
        if (!patchRes.ok) throw new Error('assignee patch failed');
        onAssigneePatched?.(assigneeId);
      }

      const dispatchRes = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type: entityType, entity_id: entityId, project_id: projectId }),
      });
      if (!dispatchRes.ok) throw new Error('dispatch failed');
      const dispatchData = await dispatchRes.json() as { dispatched?: boolean };
      if (!dispatchData.dispatched) throw new Error('dispatch not executed — assignee missing');
      addToast({ type: 'success', title: 'Dispatch 완료' });
    } catch {
      addToast({ type: 'error', title: 'Dispatch 실패. 다시 시도하겠는.' });
    } finally {
      setDispatching(false);
    }
  }, [assigneeId, dispatching, entityType, entityId, projectId, onAssigneePatched, addToast]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={assigneeId}
        onChange={(e) => setAssigneeId(e.target.value)}
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
      >
        <option value="">담당자 선택</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!assigneeId || dispatching}
        onClick={() => void handleDispatch()}
        className={cn(
          'shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition',
          mobileMode === 'assignee-only' ? 'hidden md:flex' : 'flex',
          assigneeId && !dispatching
            ? 'bg-primary text-primary-foreground hover:bg-primary/90'
            : 'cursor-not-allowed bg-muted text-muted-foreground',
        )}
      >
        <Zap className="size-3.5" />
        {dispatching ? 'Dispatching…' : 'Dispatch'}
      </button>
      {mobileMode === 'assignee-only' && (
        <div ref={moreRef} className="relative md:hidden">
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            className="flex items-center justify-center rounded-md border border-border px-2 py-1.5 text-muted-foreground transition hover:bg-muted"
            aria-label="더보기"
          >
            <MoreHorizontal className="size-4" />
          </button>
          {moreOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 min-w-[140px] rounded-md border border-border bg-background py-1 shadow-md">
              <button
                type="button"
                disabled={!assigneeId || dispatching}
                onClick={() => { void handleDispatch(); setMoreOpen(false); }}
                className={cn(
                  'flex w-full items-center gap-1.5 px-3 py-2 text-sm transition',
                  assigneeId && !dispatching
                    ? 'text-foreground hover:bg-muted'
                    : 'cursor-not-allowed text-muted-foreground',
                )}
              >
                <Zap className="size-3.5" />
                {dispatching ? 'Dispatching…' : 'Dispatch'}
              </button>
            </div>
          )}
        </div>
      )}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
