import { RouteTopBarFallback } from '@/components/nav/flat-tab-top-bar';
import { PageSkeleton } from '@/components/ui/page-skeleton';

export default function Loading() {
  // story #4326 — 불러오는 동안 상단바 제목 · 칩이 비지 않게(경로 → 제목 표).
  return (
    <>
      <RouteTopBarFallback route="rewards" />
      <PageSkeleton className="mx-auto w-full max-w-3xl space-y-5 p-6" />
    </>
  );
}
