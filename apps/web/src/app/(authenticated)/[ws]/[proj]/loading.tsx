'use client';

// story #4274(E-MOBILE-SPEED · 민 기기 배포 27) — 탭 · 메뉴 목적지 loading 경계. 이 한 파일이 프로젝트 자원 전부의 경계다(자기 loading.tsx가 있는
// 자원은 그쪽이 우선). 이 아래 page.tsx는 서버 redirect() 없이 notFound()만 쓴다(스트리밍 경계 아래 redirect() = React 오류 310 · story #3915).
//
// 도착 경로에 맞는 몸 스켈레톤을 고른다: 회고처럼 자기 폴더에 비동기 서버 layout.tsx가 있는 자원은 자기 loading.tsx가 layout 안의 page만
// 감싸서, layout이 풀리는 동안은 이 부모 경계가 보인다 — 모양이 다르면 스켈레톤이 두 번 바뀐다(4643 · parity 테스트). 도착 경로는 주소가
// 먼저 바뀌어 usePathname으로 안다. 탭 줄 자체는 story #4291부터 `[ws]/[proj]/layout.tsx`(WorkTabsFrame)가 쥔다.
import { usePathname } from 'next/navigation';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EpicsSkeleton } from '@/components/epics/epics-skeleton';
import { WorkspaceFrameLoading } from '@/components/workspace/workspace-frame-loading';
import { WORKSPACE_FRAME_TABS } from '@/components/workspace/workspace-frame-tabs';
import { RouteTopBarFallback, projectRouteOf } from '@/components/nav/flat-tab-top-bar';

export default function Loading() {
  // /{ws}/{proj}/{자원}/… — 셋째 조각이 자원 경로.
  const segment = (usePathname() ?? '').split('/').filter(Boolean)[2];
  const tab = WORKSPACE_FRAME_TABS.find((t) => t.path === segment);
  // story #4291 — 탭 줄은 레이아웃이 쥐므로 여기선 도착 여섯 탭에 맞는 몸 스켈레톤만(탭 모양 갈래 없음).
  if (tab) return <WorkspaceFrameLoading />;
  // story #4326(PO 4688) — 동적 layout 자원(목표 · 문서 · 실행)은 그 layout이 풀리는 동안 이 부모 경계가 먼저 보인다 — 상단바 폴백도 자기 loading과
  // 같은 것을 쥔다(경로 → 제목 표에 있는 자원 · 목록으로 올 때만 · 그리는 마크업은 없어 아래 모양 대조와 무관).
  const route = projectRouteOf(segment);
  const hold = route ? <RouteTopBarFallback route={route} /> : null;
  // 자기 loading.tsx가 일반 PageSkeleton이 아닌 자원 — 부모 경계도 같은 모양(안 그러면 «일반 → 자기» 두 번 바뀐다 · 목표는 동적 layout이라 부모가 보임).
  // 자기 loading과 같은 모양인지는 loading.parity.test.tsx가 폴더 전수로 대조한다.
  if (segment === 'goals') return <>{hold}<EpicsSkeleton /></>;
  return <>{hold}<PageSkeleton /></>;
}
