'use client';

import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';

interface PageSkeletonProps {
  /** `rows`(기본) = 머리 + 설명 + 줄 다섯 — 도착 화면 문법(PageHeader 제목 · 설명 → 줄 목록). `cards` = 머리 + 카드 넷(2열) — 성과 보드 전용. */
  variant?: 'rows' | 'cards';
  /** 도착 페이지와 **같은 컨테이너**(폭 · 여백) — 스켈레톤과 실제 화면의 폭이 달라 도착 때 1440에서 전폭 → 가운데 열로 튀던 것(유나 판정). */
  className?: string;
}

// story #4274(유나 판정 · 까디르 검수 P2) — 예전 모양(짧은 제목 + 96px 카드 셋 + 줄 · 폭 제한 없음)은 도착 화면(PageHeader + 줄 · max-w-3xl)과 달라
// 도착 때 블록 높이와 폭이 바뀌었다. 치수는 유나 판정 그대로: 제목 h-7 w-40 · 설명 h-4 w-64 · 줄 5 × h-14 · 성과 보드만 카드 4 grid-cols-2.
export function PageSkeleton({ variant = 'rows', className = 'space-y-6 p-6' }: PageSkeletonProps) {
  // story #4274(까디르 검수 P3) — 화면 읽기 프로그램에 «불러오는 중»을 상태로 알린다(role="status" = 암묵적 aria-live polite · aria-busy · 보이지 않는 라벨은 common.loading).
  const t = useTranslations('common');
  return (
    <div className={className} role="status" aria-busy="true">
      <span className="sr-only">{t('loading')}</span>
      <div className="space-y-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      {variant === 'cards' ? (
        <div className="grid grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      )}
    </div>
  );
}
