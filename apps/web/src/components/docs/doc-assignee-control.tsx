'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { User, UserPlus } from 'lucide-react';
import { EntityDispatchPanel } from '@/components/dispatch/entity-dispatch-panel';

/**
 * 박스1: 담당자 아바타 + popover. 슬림 헤더 액션 클러스터에 glanceable owner 신호(누가 owner인지 보여야 함).
 * Dispatch 밴드 대체 — content-dominant 유지 + 기능 보존(기존 EntityDispatchPanel picker 그대로 popover 안).
 * shadcn Popover 부재 → 코드베이스 click-outside 패턴(버튼 anchor + 조건부 패널). 신규 토큰 0.
 */
export function DocAssigneeControl({
  docId,
  projectId,
  currentAssigneeId,
  onAssigneePatched,
}: {
  docId: string;
  projectId: string;
  currentAssigneeId: string | null;
  onAssigneePatched: (assigneeId: string) => void;
}) {
  const t = useTranslations('docs');
  const [open, setOpen] = useState(false);
  const [memberName, setMemberName] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // 현 담당자 이름 resolve(아바타 이니셜용). EntityDispatchPanel도 멤버를 fetch하나 트리거 라벨용 경량 조회.
  // null 케이스는 동기 setState 대신 render서 파생(currentAssigneeId 가드)해 set-state-in-effect 회피.
  useEffect(() => {
    if (!currentAssigneeId) return;
    let alive = true;
    void fetch(`/api/members?project_id=${projectId}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((json) => {
        if (!alive) return;
        const rows = ((json?.data ?? json) as { id: string; name: string }[] | null) ?? [];
        const m = Array.isArray(rows) ? rows.find((x) => x.id === currentAssigneeId) : null;
        setMemberName(m?.name ?? null);
      });
    return () => { alive = false; };
  }, [currentAssigneeId, projectId]);

  // click-outside 닫기
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const assigned = !!currentAssigneeId;
  // currentAssigneeId 가드: 담당자 해제/변경 시 stale memberName 무시(render 파생).
  const initials = assigned && memberName ? memberName.slice(0, 2).toUpperCase() : null;
  const label = assigned ? `${t('assignee')}: ${memberName ?? ''}`.trim() : t('assigneeUnassigned');

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={label}
        aria-label={label}
        className={
          assigned
            ? 'flex size-7 items-center justify-center rounded-full border border-border bg-muted text-[10px] font-medium text-foreground'
            : 'flex size-7 items-center justify-center rounded-full border border-dashed border-muted-foreground/50 text-muted-foreground transition-colors hover:text-foreground'
        }
      >
        {assigned ? (initials ?? <User className="size-3.5" />) : <UserPlus className="size-3.5" />}
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-popover p-2 shadow-md">
          <EntityDispatchPanel
            entityType="doc"
            entityId={docId}
            projectId={projectId}
            currentAssigneeId={currentAssigneeId}
            onAssigneePatched={onAssigneePatched}
            mobileMode="assignee-only"
          />
        </div>
      ) : null}
    </div>
  );
}
