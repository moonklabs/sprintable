import { RouteTopBarFallback } from '@/components/nav/flat-tab-top-bar';
import { OrgScreenLoading } from '@/components/organization/org-screen-loading';

export default function Loading() {
  // story #4326 — 불러오는 동안 상단바 제목 · 칩이 비지 않게(경로 → 제목 표). 4913 — 본문은 도착 화면과 같은 틀(OrgScreenLoading = PageFrame).
  return (
    <>
      <RouteTopBarFallback route="rewards" />
      <OrgScreenLoading />
    </>
  );
}
