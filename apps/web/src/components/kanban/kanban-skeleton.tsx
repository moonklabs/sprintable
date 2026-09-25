'use client';

import { COLUMNS } from './types';
import { Skeleton } from '@/components/ui/skeleton';

// story #4307(유나 확정) — 보드 스켈레톤을 툴바 부분과 컬럼(목록) 부분으로 나눈다. 첫 불러오기 = 둘 다(KanbanSkeleton) ·
// 스프린트 · 담당자 필터로 다시 불러오기 = 컬럼(목록) 부분만(툴바 · 필터 버튼은 그대로라 초점이 그 버튼으로 돌아온다). 같은 부품을 쓴다.

function KanbanToolbarSkeleton() {
  return (
    <div className="flex h-11 flex-shrink-0 items-center justify-between border-b border-border/80 px-4">
      <div className="flex items-center gap-1">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-6 w-16" />
        ))}
      </div>
      <div className="flex items-center gap-1">
        <Skeleton className="h-7 w-7" />
        <Skeleton className="h-7 w-7" />
        <Skeleton className="h-7 w-14" />
      </div>
    </div>
  );
}

export function KanbanColumnsSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-3 py-3" data-testid="kanban-columns-skeleton">
      {COLUMNS.map((col) => (
        <div key={col.id} className="flex h-full w-[280px] min-w-[240px] flex-col rounded-xl bg-muted/40 p-3">
          <Skeleton className="mb-3 h-4 w-20 rounded" />
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 rounded-lg bg-background shadow-sm" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 목록 보기의 다시 불러오기 — 툴바는 그대로 · 행 자리만(유나 확정). */
export function KanbanListRowsSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-4 py-3" data-testid="kanban-list-skeleton">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <Skeleton key={i} className="h-10 w-full rounded-md" />
      ))}
    </div>
  );
}

export function KanbanSkeleton() {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <KanbanToolbarSkeleton />
      <KanbanColumnsSkeleton />
    </div>
  );
}
