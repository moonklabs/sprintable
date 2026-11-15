// 4913(UI-R5 D물결) — 채널 포스트 «한 쪽 틀» 로딩: 도착 화면과 같은 틀(OrgScreenLoading = PageFrame wide) + 불러오는 동안 위 막대 제목을 폴백으로 쥔다(story #4326).
// 이 폴더의 loading.tsx는 아래 `calendar` · `engagement` · `[draftId]`도 덮는다 — 제목 폴백은 도착 주소의 마지막 조각이 `channel-posts`일 때(= 목록 자체)만 선다(RouteTopBarFallback).
// 그 세 화면은 이 판 밖(옛 화면 그대로)이라 각자 옛 스켈레톤 loading.tsx를 따로 쥔다.
import { RouteTopBarFallback } from '@/components/nav/flat-tab-top-bar';
import { OrgScreenLoading } from '@/components/organization/org-screen-loading';

export default function Loading() {
  return (
    <>
      <RouteTopBarFallback route="content/channel-posts" />
      <OrgScreenLoading width="wide" />
    </>
  );
}
