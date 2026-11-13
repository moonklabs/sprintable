// 4913(UI-R5) — 채널 «한 쪽 틀» 로딩: 도착 화면과 같은 틀(OrgScreenLoading = PageFrame stream) + 불러오는 동안 위 막대 제목을 폴백으로 쥔다(story #4326).
import { RouteTopBarFallback } from '@/components/nav/flat-tab-top-bar';
import { OrgScreenLoading } from '@/components/organization/org-screen-loading';

export default function Loading() {
  return (
    <>
      <RouteTopBarFallback route="channel" />
      <OrgScreenLoading width="stream" />
    </>
  );
}
