'use client';

/**
 * story #4226(PO 판단 23:19Z) — flat 목적지(경로에 `/{ws}/{proj}`가 없는 화면)로 가는 앱 내부 링크가 처음부터 `?p={프로젝트}`를 싣게 한다.
 * 싣지 않으면 착지한 flat 화면에서 셸이 `?p=`를 채우려 router.replace(= 현재 페이지 RSC 재요청 · 대기 중인 다른 이동을 버릴 수 있음)를 부른다.
 * 프로젝트 = 전환 «대기 중 목표»(pending-project-switch) → 대시보드 컨텍스트의 유효 프로젝트 순. 모르면 주소를 그대로 둔다.
 * 남은 bare flat 링크는 `flat-link-project-param.ratchet.test.ts`가 센다(늘면 RED · 후속 카드 #4231이 0까지).
 */
import { useCallback } from 'react';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { usePendingProjectTarget } from '@/lib/pending-project-switch';
import { withProjectParam } from '@/lib/with-project-param';

export { withProjectParam };

export function useFlatHref(): (href: string) => string {
  const { projectId } = useDashboardContext();
  const pending = usePendingProjectTarget();
  const target = pending ?? projectId;
  return useCallback((href: string) => withProjectParam(href, target), [target]);
}
