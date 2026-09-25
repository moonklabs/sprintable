import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InboxPrefetchStarter } from '@/components/inbox/inbox-prefetch-starter';
import { InboxTopBarFallback } from '@/components/nav/flat-tab-top-bar';

// story #4276 — 스켈레톤이 뜨는 순간 결재 화면 데이터 요청을 먼저 출발시킨다(RSC 대기와 겹치게 · 폭포 제거).
export default function Loading() {
  return (
    <>
      <InboxPrefetchStarter />
      {/* story #4326 — 불러오는 동안 상단바 제목 · 칩이 비지 않게 도착 탭의 이름을 폴백으로 쥔다. */}
      <InboxTopBarFallback />
      <PageSkeleton />
    </>
  );
}
