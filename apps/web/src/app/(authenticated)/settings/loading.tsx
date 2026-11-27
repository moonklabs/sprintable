import { PageSkeleton } from '@/components/ui/page-skeleton';
import { RouteTopBarFallback } from '@/components/nav/flat-tab-top-bar';

export default function Loading() {
  // story 5031 (5a): /settings has the top bar now — while it loads the bar holds «설정» (from lg) so the path does not flash empty
  return (
    <>
      <RouteTopBarFallback route="settings" />
      <PageSkeleton className="mx-auto w-full max-w-3xl space-y-6 p-4 lg:p-6" />
    </>
  );
}
