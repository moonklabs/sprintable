'use client';

import { useTranslations } from 'next-intl';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';

/** story 4892 (UI-9 활동) — the route's loading placeholder on ds parts (was ui/page-skeleton): a title bar + a description bar + five rows, the same dimensions as the old «rows» skeleton; one «불러오는 중» for the group. */
export function ActivityLoadingSkeleton() {
  const t = useTranslations('common');
  return (
    <SkeletonGroup label={t('loading')} className="space-y-6 p-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40 lg:h-9.5" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-14" />))}
      </div>
    </SkeletonGroup>
  );
}
