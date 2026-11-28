'use client';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ds/card';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';

export function EpicsSkeleton() {
  // story #4274(까디르 검수 P3) — «목표» 탭 목적지의 loading 스켈레톤. PageSkeleton과 같게 화면 읽기 프로그램에 «불러오는 중» 상태를 알린다.
  const t = useTranslations('common');
  return (
    <SkeletonGroup label={t('loading')} className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="space-y-3 p-4">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton variant="text" className="w-full" />
            <Skeleton className="h-2 w-full" />
            <div className="flex gap-2">
              <Skeleton variant="circle" className="size-6" />
              <Skeleton variant="circle" className="size-6" />
              <Skeleton className="ml-auto h-6 w-12" />
            </div>
          </Card>
        ))}
      </div>
    </SkeletonGroup>
  );
}
