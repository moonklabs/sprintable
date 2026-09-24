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

export function withProjectParam(href: string, projectId: string | null | undefined): string {
  if (!projectId) return href;
  const [pathAndQuery, hash = ''] = href.split('#');
  const [path, query = ''] = pathAndQuery!.split('?');
  const sp = new URLSearchParams(query);
  // story #4231 — 주소가 이미 `p`를 싣고 있으면 그대로 둔다: 일부러 **다른** 프로젝트로 보내는 링크(«다른 프로젝트» 대화 열기 ·
  // 원래 프로젝트로 돌아가기)를 현재 프로젝트로 덮으면 이동 목적 자체가 바뀐다.
  if (sp.has('p')) return href;
  // story #4231 3차 — 기존 쿼리는 **글자 그대로** 두고 `p`만 덧붙인다(URLSearchParams로 다시 쓰면 compose 같은 값의 `%20`이 `+`로
  // 바뀌는 등 주소의 다른 부분을 건드린다 — 첫 지시 이동 테스트가 잡았다).
  const tail = `p=${encodeURIComponent(projectId)}`;
  return `${path}?${query ? `${query}&${tail}` : tail}${hash ? `#${hash}` : ''}`;
}

export function useFlatHref(): (href: string) => string {
  const { projectId } = useDashboardContext();
  const pending = usePendingProjectTarget();
  const target = pending ?? projectId;
  return useCallback((href: string) => withProjectParam(href, target), [target]);
}
