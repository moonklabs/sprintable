'use client';

import { useSelectedLayoutSegment } from 'next/navigation';
import type { ReactNode } from 'react';
import { MemoListClient } from './memo-list-client';

export function MemosLayoutClient({ children }: { children: ReactNode }) {
  const segment = useSelectedLayoutSegment();
  const hasDetail = segment !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:h-full lg:flex-row lg:overflow-hidden">
      {/* List panel: always on desktop, hidden when detail is open on mobile */}
      <div
        className={`flex-col border-r border-border/80 bg-background lg:flex lg:w-[340px] lg:flex-shrink-0 ${
          hasDetail ? 'hidden lg:flex' : 'flex w-full'
        }`}
      >
        <MemoListClient selectedMemoId={segment} />
      </div>

      {/* Detail / empty panel: always on desktop, shown when detail is open on mobile */}
      <div
        className={`min-w-0 flex-1 flex-col bg-background lg:flex ${
          hasDetail ? 'flex' : 'hidden lg:flex'
        }`}
      >
        {children}
      </div>
    </div>
  );
}
