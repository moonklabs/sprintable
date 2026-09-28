import { RouteTopBarFallback } from '@/components/nav/flat-tab-top-bar';
import { PageSkeleton } from '@/components/ui/page-skeleton';

export default function Loading() {
  return (
    <>
      {/* story #4326(까디르 4688) — 부모 workforce/loading은 «에이전트» 목록만 쥔다(마지막 조각 비교) — 실행 목록은 자기 경계에서 같은 표로. */}
      <RouteTopBarFallback route="organization/workforce/runs" />
      <PageSkeleton />
    </>
  );
}
