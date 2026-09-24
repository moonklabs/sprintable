'use client';

/**
 * story #4226(PO 판단 23:19Z) — flat 목적지(경로에 `/{ws}/{proj}`가 없는 화면)로 가는 앱 내부 링크가 처음부터 `?p={프로젝트}`를 싣게 한다.
 * 싣지 않으면 착지한 flat 화면에서 셸이 `?p=`를 채우려 router.replace(= 현재 페이지 RSC 재요청 · 대기 중인 다른 이동을 버릴 수 있음)를 부른다.
 * 프로젝트 = 전환 «대기 중 목표»(pending-project-switch) → 대시보드 컨텍스트의 유효 프로젝트 순. 모르면 주소를 그대로 둔다.
 * 남은 bare flat 링크는 `flat-link-project-param.ratchet.test.ts`가 센다(늘면 RED · 후속 카드 #4231이 0까지).
 */
import { useCallback, useSyncExternalStore } from 'react';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { usePendingProjectTarget } from '@/lib/pending-project-switch';
import { tabProjectCandidates } from '@/lib/project-context-client';
import { withProjectParam } from '@/lib/with-project-param';

export { withProjectParam };

/**
 * story #4231 다음 조각(래칫 맹점 ① · PO 15:10Z) — 셸 밖 화면(/today · (v3)/chat · /connect-rules)엔 대시보드 컨텍스트의 프로젝트가 없어
 * 예전엔 아무것도 안 실었다(no-op). 셸 밖에서만 이 탭이 이미 들고 있는 프로젝트(URL `?p=` → sessionStorage · 셸과 같은 순서 ·
 * tabProjectCandidates)를 쓴다. 하이드레이션 뒤에만 읽는다(첫 렌더 = 서버와 같은 값 · 셸의 hydrated 규칙과 같은 이유). 추가 호출 0 —
 * 탭 값이 없으면 지금처럼 주소 그대로.
 */
const noopSubscribe = () => () => {};

function useOutsideShellTabProject(active: boolean): string | undefined {
  // 하이드레이션 여부 — 서버 스냅숏 false · 클라이언트 true(React가 하이드레이션 동안 서버 값을 쓰고 뒤에 다시 그린다 · 불일치 0).
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  // 렌더마다 지금 주소의 ?p=를 읽는다(이동하면 소비처가 다시 그려진다). usePathname 구독은 넣지 않는다 — next/navigation을 부분 목킹한
  // 테스트 수백 개가 이 훅을 거쳐 깨졌다(4231 조각 1차 전체 실행 1467 RED).
  if (!active || !hydrated) return undefined;
  return tabProjectCandidates(new URLSearchParams(window.location.search).get('p'), true)[0];
}

export function useFlatHref(): (href: string) => string {
  const { projectId, inShell } = useDashboardContext();
  const pending = usePendingProjectTarget();
  const tabProject = useOutsideShellTabProject(!inShell);
  const target = pending ?? projectId ?? tabProject; // 셸 안이면 tabProject는 늘 undefined(훅이 읽지 않음)
  return useCallback((href: string) => withProjectParam(href, target), [target]);
}
