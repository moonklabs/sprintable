import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-4 py-3">
        <Skeleton className="h-6 w-40" />
      </div>
      <div className="flex-1 space-y-4 overflow-hidden p-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={i % 2 === 0 ? 'flex justify-start' : 'flex justify-end'}>
            <Skeleton className={`h-16 rounded-xl ${i % 2 === 0 ? 'w-2/3' : 'w-1/2'}`} />
          </div>
        ))}
      </div>
      <div className="border-t border-border p-3">
        <Skeleton className="h-12 w-full rounded-lg" />
      </div>
    </div>
  );
}
