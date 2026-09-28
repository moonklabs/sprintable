import { EpicsSkeleton } from '@/components/epics/epics-skeleton';
import { RouteTopBarFallback } from '@/components/nav/flat-tab-top-bar';

export default function Loading() {
  return (
    <>
      {/* story #4326(PO 4688) — «전체» → «목표» 불러오는 동안 상단바 제목 · 칩이 비지 않게(경로 → 제목 표 · 목록으로 올 때만). */}
      <RouteTopBarFallback route="[ws]/[proj]/goals" />
      <EpicsSkeleton />
    </>
  );
}
