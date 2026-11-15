// 4913(UI-R5) — 조직 구역 «한 쪽 틀» 로딩: 도착 화면(성과 보드 · 넓은 틀)과 같은 틀(OrgScreenLoading = PageFrame) + 불러오는 동안 위 막대 제목을 폴백으로 쥔다(story #4326).
// organization/ 전체에 한 파일로 두지 않는 이유: organization/connectors/page.tsx가 서버 redirect()를 쓴다(스트리밍 경계 아래 redirect() = React 오류 310 · story #3915) — 메뉴 목적지 화면마다 둔다.
import { RouteTopBarFallback } from '@/components/nav/flat-tab-top-bar';
import { OrgScreenLoading } from '@/components/organization/org-screen-loading';

export default function Loading() {
  return (
    <>
      <RouteTopBarFallback route="organization/insights-board" />
      <OrgScreenLoading width="wide" />
    </>
  );
}
