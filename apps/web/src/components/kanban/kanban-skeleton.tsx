'use client';

import { COLUMNS } from './types';

export function KanbanSkeleton() {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {COLUMNS.map((col) => (
        <div key={col.id} className="w-full min-w-[250px] md:w-[280px]">
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="mb-3 h-5 w-24 animate-pulse rounded bg-muted" />
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-lg border border-border bg-muted/50" />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
