'use client';

interface PageSkeletonProps {
  /** 타이틀 바 표시 */
  showTitle?: boolean;
  /** 카드 수 */
  cards?: number;
  /** 리스트 행 수 */
  rows?: number;
}

/** 범용 페이지 로딩 스켈레톤 */
export function PageSkeleton({ showTitle = true, cards = 3, rows = 5 }: PageSkeletonProps) {
  return (
    <div className="animate-pulse space-y-6 p-6">
      {showTitle && (
        <div className="h-8 w-48 rounded-lg bg-gray-200" />
      )}
      {cards > 0 && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {Array.from({ length: cards }).map((_, i) => (
            <div key={i} className="h-24 rounded-xl bg-gray-200" />
          ))}
        </div>
      )}
      {rows > 0 && (
        <div className="space-y-3">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="h-12 rounded-lg bg-gray-200" />
          ))}
        </div>
      )}
    </div>
  );
}
