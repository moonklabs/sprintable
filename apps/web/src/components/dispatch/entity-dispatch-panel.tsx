'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('board');
  // f5ae74e4: Dispatch(이벤트 전달)를 Kickoff(킥오프·워크플로우 규칙)와 라벨·툴팁으로 명확히 구분.
  const dispatchTitle = !assigneeId ? t('dispatchNeedsAssignee') : t('dispatchTooltip');

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
      // 7f8066a3: 실패 사유 구분(reason 매트릭스) — 서버 오류 vs 담당자 미지정을 분리 안내한다.
      if (!dispatchRes.ok) {
        addToast({ type: 'error', title: '전달에 실패했습니다', body: '전달 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
        return;
      }
      const dispatchData = await dispatchRes.json().catch(() => ({})) as { dispatched?: boolean };
      if (!dispatchData.dispatched) {
        // 담당자가 지정되지 않아 전달 대상이 없는 경우 — 오류가 아니라 안내(info)로 처리한다.
        addToast({ type: 'info', title: '담당자가 지정되지 않았습니다', body: '담당자를 지정한 뒤 다시 전달해 주세요.' });
        return;
      }
      addToast({ type: 'success', title: '전달했습니다' });
    } catch {
      addToast({ type: 'error', title: '전달에 실패했습니다', body: '일시적인 문제로 전달하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
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
        title={dispatchTitle}
        className={cn(
          'shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition',
          mobileMode === 'assignee-only' ? 'hidden md:flex' : 'flex',
          assigneeId && !dispatching
            ? 'bg-primary text-primary-foreground hover:bg-primary/90'
            : 'cursor-not-allowed bg-muted text-muted-foreground',
        )}
      >
        <Zap className="size-3.5" />
        {dispatching ? t('dispatching') : t('dispatch')}
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
                title={dispatchTitle}
                className={cn(
                  'flex w-full items-center gap-1.5 px-3 py-2 text-sm transition',
                  assigneeId && !dispatching
                    ? 'text-foreground hover:bg-muted'
                    : 'cursor-not-allowed text-muted-foreground',
                )}
              >
                <Zap className="size-3.5" />
                {dispatching ? t('dispatching') : t('dispatch')}
              </button>
            </div>
          )}
        </div>
      )}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
