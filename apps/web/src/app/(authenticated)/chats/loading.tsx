import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  // story #4274(까디르 검수 P3) — PageSkeleton과 같게 화면 읽기 프로그램에 «불러오는 중» 상태를 알린다.
  const t = useTranslations('common');
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="status" aria-busy="true">
      <span className="sr-only">{t('loading')}</span>
      <div className="border-b border-border px-4 py-3">
        <Skeleton className="h-5 w-24" />
      </div>
      <div className="flex-1 space-y-1 overflow-hidden p-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2.5">
            <Skeleton className="h-10 w-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
