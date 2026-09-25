'use client';

// story #4274(E-MOBILE-SPEED · 민 기기 배포 27) — 탭 · 메뉴 목적지 loading 경계. 이 한 파일이 프로젝트 자원 전부의 경계다(자기 loading.tsx가 있는
// 자원은 그쪽이 우선). 이 아래 page.tsx는 서버 redirect() 없이 notFound()만 쓴다(스트리밍 경계 아래 redirect() = React 오류 310 · story #3915).
//
// 유나 판정(4643) — 도착 경로가 일감 프레임 탭(WORKSPACE_FRAME_TABS · 탭 줄과 같은 표)이면 그 탭의 프레임 스켈레톤(탭 줄 포함)을 그린다.
// 회고처럼 자기 폴더에 비동기 서버 layout.tsx가 있는 탭은 자기 loading.tsx가 layout 안의 page만 감싸서, layout이 풀리는 동안은 이 부모
// 경계가 보인다 — 여기서 일반 스켈레톤을 그리면 보드 → 회고 이동 때 탭 줄이 ~290ms 사라졌다. 도착 경로는 주소가 먼저 바뀌어 usePathname으로 안다.
import { usePathname } from 'next/navigation';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EpicsSkeleton } from '@/components/epics/epics-skeleton';
import { WORKSPACE_FRAME_LOADING_LAYOUT, WorkspaceFrameLoading } from '@/components/workspace/workspace-frame-loading';
import { WORKSPACE_FRAME_TABS } from '@/components/workspace/workspace-frame-tabs';

export default function Loading() {
  // /{ws}/{proj}/{자원}/… — 셋째 조각이 자원 경로.
  const segment = (usePathname() ?? '').split('/').filter(Boolean)[2];
  const tab = WORKSPACE_FRAME_TABS.find((t) => t.path === segment);
  if (tab) return <WorkspaceFrameLoading active={tab.key} layout={WORKSPACE_FRAME_LOADING_LAYOUT[tab.key]} />;
  // 자기 loading.tsx가 일반 PageSkeleton이 아닌 자원 — 부모 경계도 같은 모양(안 그러면 «일반 → 자기» 두 번 바뀐다 · 목표는 동적 layout이라 부모가 보임).
  // 자기 loading과 같은 모양인지는 loading.parity.test.tsx가 폴더 전수로 대조한다.
  if (segment === 'goals') return <EpicsSkeleton />;
  return <PageSkeleton />;
}
