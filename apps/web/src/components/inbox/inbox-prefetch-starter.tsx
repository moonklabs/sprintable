'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { prefetchInbox } from './inbox-prefetch';

/**
 * story #4276 — `inbox/loading.tsx`에 얹는다. 로딩 경계는 누른 즉시 그려지므로(4274) 이 순간 결재 화면 데이터 요청을 먼저 출발시켜
 * /inbox RSC를 기다리는 동안 요청이 같이 달리게 한다. 화면은 붙을 때 같은 요청의 응답을 한 번 넘겨받는다(규칙은 inbox-prefetch.ts).
 * 개발 모드 StrictMode의 이중 effect는 inbox-prefetch.ts가 «같은 범위 · 기한 안 항목이면 다시 출발 안 함»으로 한 번만 보낸다.
 */
export function InboxPrefetchStarter() {
  const { currentTeamMemberId, projectId } = useDashboardContext();
  const tab = useSearchParams().get('tab');
  useEffect(() => {
    prefetchInbox({ memberId: currentTeamMemberId, projectId }, tab);
  }, [currentTeamMemberId, projectId, tab]);
  return null;
}
