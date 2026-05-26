'use client';
import { Skeleton } from '@/components/ui/skeleton';

export function DocsListSkeleton() {
  return (
    <div className="flex h-full">
      <aside className="hidden w-[300px] flex-shrink-0 space-y-2 border-r border-border/80 p-3 lg:block">
        <Skeleton className="h-8 w-full" />
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} variant="text" className={i % 3 === 0 ? 'w-full' : 'w-3/4'} />
        ))}
      </aside>
      <div className="flex-1 space-y-4 p-6">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton variant="text" className="w-full" />
        <Skeleton variant="text" className="w-5/6" />
        <Skeleton variant="text" className="w-4/5" />
        <div className="pt-4">
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  );
}
