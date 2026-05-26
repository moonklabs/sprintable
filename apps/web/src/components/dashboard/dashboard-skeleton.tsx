'use client';
import { Skeleton } from '@/components/ui/skeleton';

export function DashboardSkeleton() {
  return (
    <div className="space-y-6 p-4 md:p-6">
      <Skeleton className="h-7 w-48" />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2 rounded-xl border border-border/80 p-4">
            <Skeleton variant="text" className="w-20" />
            <Skeleton className="h-8 w-16" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-3 rounded-xl border border-border/80 p-4 lg:col-span-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-40 w-full" />
        </div>
        <div className="space-y-3 rounded-xl border border-border/80 p-4">
          <Skeleton className="h-5 w-24" />
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <Skeleton variant="circle" className="size-8" />
              <Skeleton variant="text" className="flex-1" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
