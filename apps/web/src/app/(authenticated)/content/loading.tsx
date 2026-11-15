// 4913(UI-R5 D물결) — 블로그 포스트 «한 쪽 틀» 로딩: 도착 화면과 같은 틀(OrgScreenLoading = PageFrame wide) + 불러오는 동안 위 막대 제목을 폴백으로 쥔다(story #4326).
// 이 폴더의 loading.tsx는 아래 `channel-posts` · `[draftId]`도 덮는다 — 제목 폴백은 도착 주소의 마지막 조각이 `content`일 때(= 목록 자체)만 선다(RouteTopBarFallback).
// 채널 포스트는 자기 loading.tsx(옛 스켈레톤)를 따로 둔다 — 그 화면을 틀로 옮길 때 같이 바뀐다.
import { RouteTopBarFallback } from '@/components/nav/flat-tab-top-bar';
import { OrgScreenLoading } from '@/components/organization/org-screen-loading';

export default function Loading() {
  return (
    <>
      <RouteTopBarFallback route="content" />
      <OrgScreenLoading width="wide" />
    </>
  );
}
