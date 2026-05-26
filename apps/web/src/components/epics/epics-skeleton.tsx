'use client';
import { Skeleton } from '@/components/ui/skeleton';

export function EpicsSkeleton() {
  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-xl border border-border/80 p-4">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton variant="text" className="w-full" />
            <Skeleton className="h-2 w-full" />
            <div className="flex gap-2">
              <Skeleton variant="circle" className="size-6" />
              <Skeleton variant="circle" className="size-6" />
              <Skeleton className="ml-auto h-6 w-12" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
