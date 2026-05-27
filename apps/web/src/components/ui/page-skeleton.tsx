'use client';

import { Skeleton } from '@/components/ui/skeleton';

interface PageSkeletonProps {
  showTitle?: boolean;
  cards?: number;
  rows?: number;
}

export function PageSkeleton({ showTitle = true, cards = 3, rows = 5 }: PageSkeletonProps) {
  return (
    <div className="space-y-6 p-6">
      {showTitle && <Skeleton className="h-8 w-48" />}
      {cards > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {Array.from({ length: cards }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      )}
      {rows > 0 && (
        <div className="space-y-3">
          {Array.from({ length: rows }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      )}
    </div>
  );
}
