'use client';

import { COLUMNS } from './types';

export function KanbanSkeleton() {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {COLUMNS.map((col) => (
        <div key={col.id} className="w-full min-w-[250px] md:w-[280px]">
          <div className="rounded-xl bg-gray-50 p-3">
            <div className="mb-3 h-5 w-24 animate-pulse rounded bg-gray-200" />
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-20 animate-pulse rounded-lg bg-gray-200" />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
