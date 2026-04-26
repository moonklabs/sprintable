'use client';

import { COLUMNS } from './types';

export function KanbanSkeleton() {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header skeleton */}
      <div className="flex h-11 flex-shrink-0 items-center justify-between border-b border-border/80 px-4">
        <div className="flex items-center gap-1">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-6 w-16 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
        <div className="flex items-center gap-1">
          <div className="h-7 w-7 animate-pulse rounded-md bg-muted" />
          <div className="h-7 w-7 animate-pulse rounded-md bg-muted" />
          <div className="h-7 w-14 animate-pulse rounded-md bg-muted" />
        </div>
      </div>

      {/* Columns skeleton */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-3 py-3">
        {COLUMNS.map((col) => (
          <div key={col.id} className="flex h-full w-[280px] min-w-[240px] flex-col rounded-xl bg-muted/40 p-3">
            <div className="mb-3 h-4 w-20 animate-pulse rounded bg-muted" />
            <div className="flex flex-col gap-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-20 animate-pulse rounded-lg bg-background shadow-sm" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
